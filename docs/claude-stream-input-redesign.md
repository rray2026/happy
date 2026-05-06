# 长存活 Claude 子进程改造设计

> 状态：草案 · 2026-05-06
> 作者：ray + Claude
> 范围：`packages/cowork-agent`（Claude 路径，Gemini 路径不变）

## 一句话摘要

把每回合 spawn 一个 `claude --print` 改成**每个 session 一个长期存活的 `claude --print --input-format stream-json` 子进程**，通过 stdin 持续投递 prompt、stdout 持续读取事件流。彻底解决"foreground 长工具调用永久卡死会话"这一类问题，同时让 Claude 自己的 `run_in_background` 工具按预期工作。

---

## 1. 背景

### 1.1 触发本设计的真实 incident

2026-05-06 一个用户会话出现了"消息发出后无响应"。日志：

```
[20:41:21] [claude] spawning: claude --print ... --resume 07dc5e87 ... 已加载，来触发下载全部聊天记录吧
[20:47:05] [sessionManager] 00d4f882-...: input ignored (busy)
[20:49:15] [sessionManager] 00d4f882-...: input ignored (busy)
```

进程链分析（`ps -ef`）：

```
cowork-agent (1688)
  └─ claude --print (3528)             # 25 分钟未退出
       └─ zsh -c "pnpm dev:logs" (3920)
            └─ pnpm dev:logs (3923)    # watch 进程，永远不会退出
```

Claude 在 `--print` 模式下使用 Bash 工具跑了一个 `pnpm dev:logs`（dev watcher）。该命令永不退出，导致 claude 主进程在 `waitpid` 上阻塞 → `runClaudeProcess` 的 Promise 永不 settle → `agentBusy` 永远为 `true` → 后续所有用户输入被静默丢弃。

### 1.2 当前架构为什么必然出现这类问题

`claudeProcess.ts` 当前模型：

```ts
// 每回合：spawn 一个 claude，等它退出，得到完整一回合的事件
const child = spawn('claude', ['--print', '...', prompt], { stdio: ['ignore', 'pipe', 'inherit'] });
child.on('close', (code) => settle(code));
```

含义：**回合（turn）和进程生命周期被绑定在一起**。任何能让 claude 进程不退出的事情，都会让这个回合永远不结束 → 整个 session 无法接受新输入。

实测发现的具体卡死场景：

| 场景 | 是否卡死 |
|------|---------|
| Bash 工具运行 foreground 长进程（dev/watch/daemon） | ❌ 永远卡死 |
| Bash 工具用 `run_in_background=true` | ❌ claude 进程会一直陪到 bg 任务结束（详见 §2.2） |
| 后台子进程继承 stdout 管道 | ❌ `'close'` 事件不触发 |
| 同步等待长任务（build / test） | ⚠️ 卡到任务结束（合理但体验差） |

### 1.3 已经做了/不做的两个小修复

- **已落地**（`claudeProcess.ts:98`）：`'exit'` 事件触发 100ms 后强制 destroy stdout 管道。解决"后台子进程持有继承管道"导致 `'close'` 永远不触发的子问题。**保留**作为新方案中的清理兜底。
- **不做**：空闲超时。会和"用户故意让它等长任务"的场景冲突，且新方案下这个问题不存在。

---

## 2. 关键发现：spike 实验结果

2026-05-06 实测了 Claude Code 2.1.128 的 `--input-format stream-json` 行为，决定本设计走向。脚本见 `/tmp/claude_stream_spike.py`。

### 2.1 Spike 1：流式输入跨回合

```
spawn claude --print --input-format stream-json --output-format stream-json
↓
write {"type":"user","message":{"role":"user","content":"prompt1"}} → stdin
read result event from stdout
↓
write {"type":"user","message":{"role":"user","content":"prompt2"}} → stdin   # 同一进程
read result event from stdout
↓
close stdin → claude 干净退出 (exit code 0)
```

✅ 同一 claude pid 处理多轮，每轮自带一个 `system/init` 事件作为新回合的开始标记。

### 2.2 Spike 2：`run_in_background` 跨回合持久化

```
turn 1: Bash(command="bash -c 'echo MARK; sleep 60'", run_in_background=true)
        → tool_result: "Command running in background with ID: bbtjgyfpm.
                        Output is being written to: /private/tmp/claude-501/.../tasks/bbtjgyfpm.output"

turn 2: 让 claude 读那个后台任务的输出
        → claude 用 ToolSearch 找 BashOutput，**没找到**（--print 模式下 BashOutput 不在工具集）
        → 自动降级：Read 该 output 文件
        → 读到 sleep 还在跑、output 已经有 "MARK" 字样
```

✅ 后台任务跨回合存活，下回合可读其输出。
⚠️ `BashOutput` 工具在 `--print` 模式下不可用，但 Claude 会自己降级到 `Read` 文件。

### 2.3 Spike 3：busy 期间发送新 prompt

```
turn 1 发送：sleep 20 (foreground)
3s 后立即发送 turn 2：Say turn2 quick
最终：1 个 result event，文本是 "turn1 done\n\nturn2 quick"  ← 两条 prompt 被合并！
```

⚠️ **不能**把 stdin 当无锁队列用 —— 在当前回合 in-flight 时写第二条会被合并到同一个 inference。**应用层必须维护队列**，仅在收到上一回合的 `result` 事件后才推进下一条。

---

## 3. 新架构

### 3.1 全景图

```
┌───────────────────────────────────────────────────────────────────┐
│ cowork-agent process                                              │
│                                                                   │
│  SessionManager                                                   │
│  ├─ session A ─┬─ ClaudeChannel ────┐                             │
│  │             │   queue [msg, msg] │                             │
│  │             │   busy: true       │                             │
│  │             │   resultPending: 1 │                             │
│  │             └─ child(claude --print --input-format stream-json)│
│  │                  │ stdin  ← write JSON line per dequeue        │
│  │                  └ stdout → read events → broadcast            │
│  ├─ session B ─… (独立 claude 进程，独立队列)                      │
│  └─ …                                                             │
└───────────────────────────────────────────────────────────────────┘
```

每个 session 独占一个 `ClaudeChannel`，封装：
- 一个长存活的 claude 子进程
- 一条 prompt 入队队列
- busy/dispatch 状态机
- abort 路径
- 优雅关停路径

### 3.2 状态机

```
              ┌──────────┐
              │   IDLE   │  ←── result 事件 + 队列空
              └────┬─────┘
                   │ enqueue & dispatch
                   ↓
              ┌──────────┐
              │   BUSY   │  ←── enqueue（推队列，不写 stdin）
              └────┬─────┘
                   │ result event
                   ├── queue 非空 → 自动 dispatch 下一条 → BUSY
                   └── queue 空   → IDLE
```

`abort()` 在 BUSY 时合法：清空队列 + 向 stdin 写 abort 信号（详见 §3.5），最终触发一个 result/error 事件让状态回到 IDLE。

### 3.3 IO 协议（基于 spike 验证）

**spawn 命令行**（替代当前 `claudeProcess.ts` 的 cliArgs）：

```ts
const cliArgs = [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
];
if (model) cliArgs.push('--model', model);
if (resumeSessionId) cliArgs.push('--resume', resumeSessionId);  // 仅初次 spawn 用
cliArgs.push(...agentArgs);
// 注意：不再附带 prompt 在 argv 末尾
```

**写入格式**（每条 prompt 一行 JSON）：

```json
{"type":"user","message":{"role":"user","content":"用户文本"}}\n
```

**读取**：现有 `rl.on('line')` + `JSON.parse` 不变，事件类型保持原样（`assistant` / `user` / `system/init` / `system/task_*` / `result/success` / `result/error`）。

**回合边界判定**：以 `result` 事件为分界。每条 prompt 对应一个 `result`（验证过的不变量）。

### 3.4 生命周期

| 阶段 | 触发 | 动作 |
|------|------|------|
| 创建 | `SessionManager.create()` 或 `rehydrate()` 后第一条 `handleInput` | spawn claude，等 `system/init` 事件确认进程就绪。无需立即发 prompt（下面 dispatch 时再写） |
| 投递 | `handleInput()` | 进 queue，若 IDLE 立即 dispatch（写 stdin） |
| 回合结束 | 收到 `result` 事件 | busy=false；queue 非空则 dispatch 下一条 |
| 主动 abort | `abort(sessionId)` | §3.5 |
| Session 关闭 | `close(sessionId)` 或 `dispose()` | §3.6 |
| 进程意外退出 | `child.on('exit')` 在非关闭路径触发 | 标记 channel 死亡，向 session 流广播 `result/error`，下次 handleInput 时按需重启 |

### 3.5 Abort 路径（已 spike 验证，方案确定）

向 stdin 写一行：

```json
{"type":"control_request","request":{"subtype":"interrupt"}}
```

Claude 的响应（顺序固定）：

1. **`control_response`** `{"response":{"subtype":"success"}}` —— 同步确认收到
2. 如果当前 BUSY：
   - 工具子进程**自动被 Claude 杀掉**（实测 `pgrep` 立即查不到 sleep 60）—— cowork-agent **不需要**追杀进程树
   - 合成一条 `user/tool_result`：`"The user doesn't want to proceed with this tool use. The tool use was rejected..."`（让 Claude 自己理解 abort 的语义）
   - `result/error_during_execution` 事件 —— 标记当前回合结束，状态机转 IDLE
3. 如果当前 IDLE：仅返回 control_response，无副作用
4. Claude 进程**始终保持存活**，下一条 prompt 立即可用

实测对比四种候选：

| 方法 | 实测行为 | 评估 |
|------|---------|------|
| **`control_request` interrupt** | 干净 abort + 自动杀子进程 + 发 result + 保活 | ✅ **采用** |
| SIGINT | 当前回合 abort，但 **claude 自身随后退出** | ❌ 不能用 |
| 关闭 stdin | 不立即 abort，等 in-flight 自然结束 | ❌ 仅适合关停 |
| SIGTERM | 进程死，需要重新 spawn + `--resume` | ⚠️ 仅作 control_request 失败时的兜底 |

#### `ClaudeChannel.abort()` 实现要点

```ts
async abort(): Promise<void> {
  // 1. 清空尚未投递的 prompt 队列，给每条产生一个 result/error("aborted before dispatch")
  while (this.queue.length > 0) {
    const pending = this.queue.shift()!;
    this.events.emit({ type: 'result', subtype: 'error', result: 'aborted before dispatch' });
    pending.resolve();  // 不让等待方挂着
  }

  // 2. 写 control_request,等 control_response 同步确认
  const ackPromise = this.waitForControlResponse(timeoutMs: 2000);
  this.stdin.write(JSON.stringify({
    type: 'control_request',
    request: { subtype: 'interrupt' },
  }) + '\n');

  try {
    await ackPromise;  // 收到 control_response/success 即可
  } catch {
    // 罕见兜底:control_response 超时 → SIGTERM + 重启 channel
    return this.hardRestart();
  }

  // 3. result/error_during_execution 会异步到来,由通用事件处理路径让状态机回到 IDLE
}
```

`waitForControlResponse` 在 stdout 解析层维护一个一次性 hook，匹配 `{type:"control_response"}` 后 resolve。

`result/error_during_execution` 不需要 abort 特殊逻辑,通用事件循环看到 `result` 事件就把 busy 置 false 并广播给客户端,等同于正常回合结束。

### 3.6 优雅关停

```
1. close stdin
2. 等待 5s，看 claude 是否自己 exit
3. 没退 → SIGTERM
4. 再等 2s
5. 还没退 → SIGKILL
6. 'exit' / 'close' 触发后清理 channel
```

之前装好的 `'exit'` + 100ms destroy stdout 兜底**保留**，处理后台子进程继承管道的边角 case。

### 3.7 错误处理

| 异常 | 处理 |
|------|------|
| spawn 失败 (`'error'` 事件，ENOENT 等) | 跟现在一样，`result/error` 上报后清掉 channel |
| stdin 写入 EPIPE | claude 已死。广播 `result/error`，标记 channel 死亡，下次 handleInput 重建 |
| stdout 收到非 JSON 行 | 跟现在一样，跳过 |
| claude 长时间无 result 输出 | **不**自动超时（用户可能在等大 build）。靠 abort 按钮 |
| 客户端断连 | session 仍存活，channel 不动；reconnect 时 replay 最近事件 |

---

## 4. 接口变更

### 4.1 `claudeProcess.ts`

**当前导出**：`runClaudeProcess(opts: RunClaudeOptions): Promise<number>` —— 一次性回合。

**新导出**：

```ts
export class ClaudeChannel {
  constructor(opts: ChannelOptions);
  /** 排队投递 prompt。返回一个 Promise，在该 prompt 对应的 result 事件后 resolve。
   *  busy 时排队；IDLE 时立即写 stdin。 */
  send(prompt: string): Promise<void>;
  /** 中断当前 in-flight 回合并清空队列。返回一个 Promise，状态回到 IDLE 后 resolve。 */
  abort(): Promise<void>;
  /** 优雅关停 channel。 */
  close(): Promise<void>;
  /** 当前是否 busy（at least one prompt in flight）。 */
  isBusy(): boolean;
  /** 队列里待发的 prompt 数量。 */
  pendingCount(): number;
}

interface ChannelOptions {
  resumeSessionId: string | null;     // 仅在初次 spawn 时使用
  model: string | undefined;
  agentArgs: string[];
  cwd: string;
  onEvent: (event: unknown) => void;  // 等同当前 runClaudeProcess 的 onEvent
  onSessionId: (id: string) => void;  // 等同当前 onSessionId
  onChannelDeath: (reason: string) => void;  // 进程意外退出时通知 SessionManager
  command?: string;                    // test override
  extraEnv?: Record<string, string>;
}
```

`runClaudeProcess` 删除（或保留作为内部一次性 spawn 工具，不再用于会话）。

### 4.2 `sessionManager.ts`

**SessionEntry 改动**：

```ts
interface SessionEntry {
  // 删除：abort: AbortController; agentBusy: boolean;
  // 新增：
  channel: ClaudeChannel | null;   // gemini 路径下为 null
  // 保留其它字段
}
```

**handleInput 改动**：

```ts
async handleInput(sessionId: string, text: string): Promise<void> {
  const entry = this.sessions.get(sessionId);
  if (!entry) throw new Error(`unknown session: ${sessionId}`);

  this.appendAndBroadcast(sessionId, { type: 'user', message: { role: 'user', content: text } });

  if (entry.tool === 'gemini') { /* 原逻辑保持 */ return; }

  // 懒初始化 channel（首次 send 时 spawn）
  if (!entry.channel) {
    entry.channel = new ClaudeChannel({
      resumeSessionId: entry.claudeSessionId,
      model: entry.model,
      agentArgs: entry.agentArgs,
      cwd: entry.cwd,
      onEvent: (e) => this.appendAndBroadcast(sessionId, e),
      onSessionId: (cid) => { /* 持久化逻辑同现在 */ },
      onChannelDeath: (reason) => {
        this.appendAndBroadcast(sessionId, { type: 'result', subtype: 'error', result: `claude channel died: ${reason}` });
        entry.channel = null;  // 下次 handleInput 重建
      },
      command: this.opts.claudeCommand,
      extraEnv: this.opts.claudeExtraEnv,
    });
  }

  // 不再阻塞当前调用：channel 内部排队
  entry.channel.send(text).catch((err) => logger.debug(`send failed: ${err.message}`));
}
```

**abort / close 改动**：

```ts
abort(sessionId: string): void {
  const entry = this.sessions.get(sessionId);
  if (!entry) return;
  entry.channel?.abort();
  entry.geminiSession?.dispose();
}

close(sessionId: string): boolean {
  const entry = this.sessions.get(sessionId);
  if (!entry) return false;
  entry.channel?.close();   // 异步关停，不等
  entry.geminiSession?.dispose();
  this.sessions.delete(entry.id);
  // ...其余原逻辑
}
```

**SessionMeta 新增 busy 字段**（供 webapp 使用）：

```ts
export interface SessionMeta {
  // ...原字段
  busy: boolean;
  pending: number;  // queue 长度
}
```

每次 channel busy 状态变化或队列变化时调用 `emitSessionsChanged()`。

### 4.3 wsServer / 协议

**不需要新协议**。现有的 `input` / `abort` / `close` / `sessions` 消息语义完全保留。`SessionMeta` 加字段是向后兼容的扩展。

---

## 5. 持久化与重启

- 现有 `sessionStorage.ts` 保存的字段不变（`id`/`tool`/`cwd`/`claudeSessionId`/`geminiSessionId`/`agentArgs`/`model`）
- agent 进程重启后，`rehydrate` 不立即 spawn channel（懒初始化），跟现在的行为一致
- 用户首次发消息时，channel spawn 时带 `--resume <claudeSessionId>`，恢复磁盘里的对话历史

**新增风险**：长存活 channel 在 agent 进程崩溃时会丢内存上下文。但 Claude Code 自己会把每条 user message 写盘到 `~/.claude/projects/...`，重启后 `--resume` 能恢复，**功能上不丢数据**，只是回合编号会有间隔。可接受。

---

## 6. 资源消耗预估

每个 live channel ≈ 一个 claude 进程：

| 维度 | 单进程 | MAX_SESSIONS=10 时 |
|------|-------|-------------------|
| 常驻 RSS | 估 200-400 MB | 2-4 GB |
| 文件描述符 | ~10 | ~100 |
| CPU（idle） | ~0% | ~0% |

实际场景下 10 个并发 session 不常见，**通常 1-3 个**，内存压力不大。如担心，可暴露环境变量 `COWORK_AGENT_MAX_LIVE_CHANNELS`，超出后用 LRU 关闭最久不用的 channel（下次用户发消息时再 spawn）。**初版不实现**，留作后续优化。

---

## 7. 测试策略

### 7.1 单元测试

需要更新的测试：
- `wsServer.test.ts` 用的 fake claude 二进制要支持 stream-json 输入：从 stdin 读 JSON 行，按规则吐 stream-json 输出。可在 `test-fixtures/` 新加一个 `fake-claude-stream.mjs`
- `sessionManager.test.ts` 加 channel 行为覆盖：busy/queue/abort/close

### 7.2 spike-derived 集成测试（建议加）

按 spike 三个场景写真实 claude 集成测试（标记为 `@requires-claude`，CI 默认跳过）：

1. 串行两条 prompt，验证 2 个 result 事件
2. turn 1 用 `run_in_background`，turn 2 读其输出
3. busy 期间排队，验证最终结果不被 merge

### 7.3 手工回归

在用户原始 incident 的项目（weaver-octopus）跑一遍：
- 让 Claude 自动启动 dev 服务器，应该返回秒级
- 紧接着发新消息，应该立即被处理
- 然后让 Claude 用 `BashOutput`（如果它降级到 Read 也可）查看 dev server 日志

---

## 8. 迁移与回滚

### 8.1 实现拆分（建议）

| 阶段 | 内容 | 可独立合入 |
|------|------|-----------|
| **P0** | abort 信号机制实测（§3.5）+ 写决策记录到本文档 | ✅ |
| **P1** | 新 `ClaudeChannel` 类（不接入），含单测 | ✅ |
| **P2** | `SessionManager` 切换到 channel + 新 `SessionMeta` 字段 | ✅ |
| **P3** | webapp 加 busy 指示 + abort 按钮 | ✅ |
| **P4** | 移除旧 `runClaudeProcess` 路径 | ✅ |

每个阶段独立可合入、可回滚。

### 8.2 灰度开关

实现期间用环境变量 `COWORK_AGENT_USE_CHANNEL=1` 开启新路径，默认走旧路径。验证稳定后翻转默认值，再过一阵移除旧路径。

### 8.3 回滚条件

- 长存活 claude 进程出现内存泄漏（持续运行 > 1 天 RSS 单调上升）
- claude 子进程崩溃恢复路径出现频繁假死
- 用户报告 abort 不可靠

---

## 9. 风险清单

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| stream-json 输入协议在未来 claude 版本变化 | 低 | 高 | 在 spawn 后立即等 `system/init` 事件并 sanity-check version 字段，不匹配时 fallback 到旧路径 |
| Abort 信号不可靠 | 低（已 spike 验证） | 中 | §3.5 control_request interrupt 实测可靠;control_response 超时时回落到 SIGTERM + `--resume` 重启 |
| 长存活进程内存泄漏 | 低 | 中 | 暴露 LRU 关闭老 channel 的开关；监控日志 |
| `BashOutput` 在 --print 模式不可用导致 Claude 体验下降 | 已确认 | 低 | 实测 Claude 自动降级到 `Read` task 输出文件，功能等价 |
| 队列里有 N 条消息时用户突然 abort，N 条全丢 | 中 | 低 | 设计：abort 清空队列前先把它们以 `result/error("aborted before dispatch")` 形式落到 session 流，UI 可见 |
| 多个 client reconnect 同一 session 时 channel 状态不一致 | 低 | 低 | channel 状态只属 server，client 完全靠 replay。无客户端侧状态歧义 |

---

## 10. 工作量估算

| 模块 | 估算 |
|------|------|
| §3.5 abort 信号 spike + 决策 | ✅ 已完成（2026-05-06） |
| `ClaudeChannel` 实现 + 单测 | 1 天 |
| `SessionManager` 切换 + SessionMeta 扩展 + 测试更新 | 半天 |
| webapp busy 指示 + abort 按钮 | 半天 |
| 集成测试 + 手工回归 | 半天 |
| **总计** | **3 天**（含联调和调整） |

---

## 11. 决策点（需用户确认后再开干）

1. **是否同意整体方向？**（长存活 channel + 应用层队列）
2. **是否需要先做 §3.5 abort spike 再写实现？**（强烈建议是）
3. **灰度开关默认要不要保留几个版本？**（建议保留至少一个版本观察）
4. **busy / abort UI 谁实现？**（cowork-agent 我可以做，webapp 部分需要协同）
5. **`BashOutput` 不可用算可接受吗？**（建议接受，让 Claude 自动降级到 Read task 输出文件）

---

## 附录 A：spike 脚本

- `/tmp/claude_stream_spike.py` —— `basic` / `bg_persist` / `busy`,支撑 §2 所有结论
- `/tmp/claude_abort_spike.py` —— 四种 abort 候选对比,确认 `control_request` 可用,SIGINT/stdin_close 不可用
- `/tmp/claude_abort_spike_v2.py` —— 验证 in-flight 工具调用期间 abort 会自动杀子进程,支撑 §3.5
- `/tmp/abort_idle.py` —— 验证 IDLE 时 abort 安全无副作用

## 附录 B：相关文件

- `packages/cowork-agent/src/claudeProcess.ts` — 待重构的核心文件
- `packages/cowork-agent/src/sessionManager.ts` — busy/channel 状态管理
- `packages/cowork-agent/src/wsServer.test.ts` — fake claude 测试基础设施
- `docs/protocol.md` — 现有 WebSocket 协议（不变）

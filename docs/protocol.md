# Wire Protocol

`cowork-agent` 启动嵌入式 WebSocket 服务器，`cowork-webapp` 扫 QR 直连。本文档描述两者之间的全部通信协议。

相关源码：
- Agent：`packages/cowork-agent/src/`（`schemas.ts` / `types.ts` / `wsServer.ts` / `auth.ts` / `sessionStore.ts` / `sessionManager.ts` / `serve.ts`）
- Webapp：`packages/cowork-webapp/src/session/client.ts`

---

## 1. 连接与聊天两层 sessionId

协议里有**两个独立的 sessionId**，一定要分清：

| 名称 | 含义 | 生成方 | 出现位置 |
|---|---|---|---|
| **Connection sessionId** | 本次 cowork-agent serve 进程的身份（鉴权凭据绑定于此） | CLI 启动时生成并写入 `keysPath`，在 QR payload / credential 中出现 | `DirectQRPayload.sessionId` / `welcome.sessionId` / credential payload |
| **Chat sessionId** | 一次聊天会话的身份（类似 IM 里一个聊天框），每个 chat session 有自己的 AI 子进程和独立 seq 空间 | `SessionManager.create()` 生成（UUID） | `message.sessionId` / `input.sessionId` / `session.*` RPC 的 params |

**一个 connection 可以承载 ≤ `MAX_SESSIONS`（= 10）个 chat session**。每个 chat session：
- 有独立的 `tool`（`claude` / `gemini`）和可选 `model`
- 有独立的 SessionStore（循环缓冲 200 条事件）
- 有独立的 seq 计数器（从 0 开始单调递增）
- 有独立的 agent 子进程生命周期和 abort 控制

---

## 2. 协议阶段

协议由两个严格分离的阶段组成，每条 WebSocket 连接都从 Phase 1 开始，握手成功后才进入 Phase 2。

| 阶段 | 允许的入站消息 | 允许的出站消息 | 退出条件 |
|---|---|---|---|
| **Phase 1: 握手** | `hello`（首次或重连，二选一） | `welcome`（成功）/ `error` + close（失败） | 成功 → 进入 Phase 2；失败 → 连接关闭 |
| **Phase 2: 会话** | `input` / `rpc` / `pong` | `message` / `sessions` / `rpc-response` / `ping` / `error` + close | 连接关闭 |

**严格校验**：agent 侧入站消息一律用 Zod schema 校验（见 `schemas.ts`）。任何不符合当前阶段 schema 的消息（包括跨阶段消息、额外字段、类型错误）一律回 `error` 并 `close`。这意味着：

- Phase 1 只接受两种 `hello` shape；发 `input` / `rpc` / `pong` → `'expected hello message'` + close。
- Phase 2 不再接受 `hello`；重新认证必须重连。
- 所有消息对象都是 `strict` 模式，多余字段会被拒绝（防止注入）。

## 3. 消息类型一览

### Webapp → Agent

| type | 阶段 | 触发时机 |
|---|---|---|
| `hello` | Phase 1 | 连接建立后立即发送（首次扫码或带 credential 重连） |
| `input` | Phase 2 | 用户在**某个 chat session** 里发送消息；agent 将其入对应 store 分配 seq 并回显 |
| `rpc` | Phase 2 | 调用 agent 侧方法（包括所有 chat session 管理 RPC） |
| `pong` | Phase 2 | 响应 agent 的 `ping` |

### Agent → Webapp

| type | 阶段 | 触发时机 |
|---|---|---|
| `welcome` | Phase 1 末 | 握手验证通过；内含当前全部 chat session 快照 |
| `error` | 任意 | 握手失败 / schema 校验失败 / JSON 错误；发出后立即 `close` |
| `message` | Phase 2 | 广播某个 chat session 的事件（延续该 session 的 seq） |
| `sessions` | Phase 2 | chat session 列表发生变化（创建 / 关闭）时主动推送 |
| `ping` | Phase 2 | 每 30 秒心跳 |
| `rpc-response` | Phase 2 | 响应 webapp 的 RPC 请求 |

完整消息结构（字段语义、校验规则、JSON 示例）见独立文档 [messages.md](messages.md)。

---

## 4. 首次连接握手

```
CLI                                          Webapp
────────────────────────────────────────────────────────────────

generateCliKeys() (→ connection sessionId)   扫描 QR 码
buildQRPayload(endpoint, keys, sessionId)    解析 qrPayload
displayQRCode(qrJson)

startWsServer(port=4000)
SessionManager.create({tool:'claude'})       new WebSocket(endpoint)
  → chat session "abc-..." 产生                ←── ws.onopen

                                ←── { type:'hello',
                                       nonce: qrPayload.nonce,
                                       webappPublicKey: Base64(...) }

verifyNonce(nonce, qrPayload.nonce, nonceExpiry)
  ├─ Date.now() > nonceExpiry ? → close('nonce expired or invalid')
  └─ nonce !== qrPayload.nonce ? → close('nonce expired or invalid')

issueCredential(webappPublicKey, sessionId, signSecretKey)

──► { type:'welcome',
       sessionId: <connection sessionId>,
       sessionCredential,
       sessions: [
         { id:'abc-...', tool:'claude', model:null, cwd:'/…', createdAt:…, currentSeq:-1 },
         ...
       ] }

// 对 welcome.sessions 里的每个 chat session 依次 replay 全量事件：
──► { type:'message', sessionId:'abc-...', seq:0, payload:... }
──► { type:'message', sessionId:'abc-...', seq:1, payload:... }
...

                                             收到 welcome → 存储 sessionCredential
                                             sessions 进入 client.sessions
                                             setStatus('connected')
```

---

## 5. 重连握手

```
CLI                                          Webapp
────────────────────────────────────────────────────────────────

                                             storage.loadCredentials()
                                             ← { endpoint, cliPublicKey,
                                                 sessionCredential,
                                                 lastSeqs: { 'abc-...': 5,
                                                             'def-...': 12 },
                                                 ... }

                                             new WebSocket(endpoint)
                                             ←── ws.onopen

                                ←── { type:'hello',
                                       sessionCredential,
                                       webappPublicKey,
                                       lastSeqs: { 'abc-...': 5,
                                                   'def-...': 12 } }

verifyCredential(credential, signPublicKey)
  ├─ 验证 Ed25519 签名
  ├─ Date.now() > payload.expiry ? → close('invalid credential')
  └─ payload.sessionId !== connectionSessionId ? → close('invalid credential')

──► { type:'welcome',
       sessionId: <connection sessionId>,
       sessionCredential,
       sessions: [
         { id:'abc-...', tool:'claude', model:null, ..., currentSeq: 8 },
         { id:'def-...', tool:'gemini', model:null, ..., currentSeq: 15 },
         { id:'ghi-...', tool:'claude', model:null, ..., currentSeq: -1 }
       ] }

// 对每个返回的 chat session，按 lastSeqs 取 delta（未出现过的 session 按 -1 = 全量）：
──► { type:'message', sessionId:'abc-...', seq:6, payload:... }
──► { type:'message', sessionId:'abc-...', seq:7, payload:... }
──► { type:'message', sessionId:'abc-...', seq:8, payload:... }
──► { type:'message', sessionId:'def-...', seq:13, payload:... }
──► { type:'message', sessionId:'def-...', seq:14, payload:... }
──► { type:'message', sessionId:'def-...', seq:15, payload:... }
// ghi-... 是重连后才新建的 → 没出现在 lastSeqs → 按 fromSeq=-1 全量回放（本例为空）

                                             更新 lastSeqs[sid] 逐条，持久化到 storage
                                             setStatus('connected')
```

**断线期间 agent 新建的 chat session 也会出现在 welcome.sessions 里**；webapp 首次看到它们时 `lastSeqs` 里没有对应 key，自动按 `-1`（全量）回放。被关闭的 chat session 不再出现在 `welcome.sessions`，webapp 侧应相应从 `sessions` 列表中移除。

重连策略（webapp 侧）：指数退避，初始 1s，最大 30s。

---

## 6. QR Payload 结构

```ts
interface DirectQRPayload {
  type: 'direct';
  endpoint: string;           // WebSocket 地址，如 "ws://192.168.1.100:4000"
  cliSignPublicKey: string;   // Base64(CLI Ed25519 公钥)，用于验证 credential 签名
  sessionId: string;          // Connection sessionId（UUID）
  nonce: string;              // Base64(32字节随机数)
  nonceExpiry: number;        // Unix 时间戳（ms），默认 5 分钟后过期
}
```

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COWORK_AGENT_PORT` | `4000` | 服务器监听端口 |
| `COWORK_AGENT_BIND` | `127.0.0.1` | 绑定的网卡地址。设为 `0.0.0.0` 允许 LAN 其他设备连接 |
| `COWORK_AGENT_ENDPOINT` | `ws://localhost:4000` | 写入 QR 的地址（webapp 实际连接此地址） |
| `COWORK_AGENT_HOME` | `~/.cowork-agent` | 存放密钥 / 日志的目录 |

---

## 7. Chat Session 生命周期

**启动时**：`serve.ts` 会根据 CLI 参数（`--claude` / `--gemini` / `--model`）自动 `manager.create(...)` 一个 chat session，使 `cowork-agent --gemini` 这种老用法在 webapp 未主动创建会话时也能直接有个聊天框可用。

**运行时**：webapp 通过 `session.create` / `session.close` RPC 管理 chat session。每次成功 create/close 后，agent 会主动推送一条 `sessions` 消息（含最新完整列表）供 webapp 刷新侧边栏。

**上限**：同一 connection 同时存活的 chat session 不能超过 `MAX_SESSIONS = 10`（`sessionManager.ts` 常量）。超出时 `session.create` 返回 `error: 'session limit reached (max 10)'`。

**工作目录**：当前实现中所有 chat session 都使用 agent 进程的启动目录作为 `cwd`（`process.cwd()`）。每个 chat session 的 `cwd` 字段会出现在 `SessionMeta` 里供 webapp 展示。

---

## 8. Agent 事件 Payload

`message.payload` 的内容取决于该 chat session 的 agent 类型。消息的 `sessionId` 字段告诉 webapp 这条事件属于哪个聊天框。

### Claude（stream-json 格式）

```ts
// 思考过程
{ type: 'thinking'; thinking: string }

// 工具调用
{ type: 'tool_use'; id: string; name: string; input: unknown }

// 工具结果
{ type: 'tool_result'; tool_use_id: string; content: string | unknown[]; is_error: boolean }

// 助手回复
{
  type: 'assistant';
  message: { role: 'assistant'; content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; ... }> }
}

// 会话 ID（首条消息）
{ type: 'system'; session_id: string }

// Turn 结束
{ type: 'result'; subtype: 'success' | 'error'; result: string }
```

### Gemini（ACP 转换后）

Gemini ACP 事件经 `geminiAcp.ts` 转换为兼容 Claude 格式：

```ts
// 文本输出 — 进度式 delta（_delta:true）+ 收尾标记（_final:true）
{
  type: 'assistant';
  message: { role: 'assistant'; content: [{ type: 'text'; text: string }] };
  _delta?: boolean;
  _final?: boolean;
  _streamId?: string;
}

// 工具调用
{
  type: 'assistant';
  message: { role: 'assistant'; content: [{ type: 'tool_use'; id: string; name: string; input: unknown }] }
}

// Turn 结束（SessionManager 在 prompt 完成后广播）
{ type: 'result'; subtype: 'success'; result: 'Done' }

// 权限请求（Gemini 专属，见第 9 节）
{
  type: 'permission-request';
  permissionId: string;   // UUID，用于 session.permissionResponse RPC 关联
  toolName: string;
  input: unknown;
}
```

### 用户事件（`input` 回显）

```ts
{
  type: 'user';
  message: { role: 'user'; content: string }
}
```

---

## 9. 权限请求流程（Gemini）

Gemini 执行工具前会向 CLI 发起 `session/request_permission` ACP 请求，CLI 将其包装成事件广播给 webapp。

```
Gemini                SessionManager                       Webapp
──────────────────────────────────────────────────────────────────

──► session/request_permission
      {toolCall: {title:'bash',...}, options:[...]}

    permissionId = randomUUID()
    entry.permissionPending.set(permissionId, resolve)
    appendAndBroadcast(sid, {
      type: 'permission-request',
      permissionId,
      toolName: 'bash',
      input: toolCall
    })
                                  收到 message.payload.type === 'permission-request'
                                  显示对话框：工具名 + 参数 + [允许]/[拒绝]
                                  用户点击 [允许]

                      ←── { type:'rpc', id:'xxx',
                              method:'session.permissionResponse',
                              params:{ sessionId, permissionId, approved: true } }

    manager.permissionResponse(sid, permissionId, true)
    resolver(true)
    sendRpcResponse(id, {ok:true})

                                  ──► { type:'rpc-response', id:'xxx', result:{ok:true} }

    write({jsonrpc:'2.0', id:msgId,
           result:{optionId:'proceed_always'}})

◄── result: {optionId: 'proceed_always'}
    继续执行工具
```

---

## 10. RPC 方法

所有 RPC 调用均为 webapp → CLI 方向，30 秒超时。Chat session 管理相关 RPC 全部以 `session.` 前缀命名。

### `session.list`

列出当前 connection 上所有 chat session。

```ts
// 请求
{ type: 'rpc', id, method: 'session.list', params: {} }

// 响应
{ type: 'rpc-response', id, result: { sessions: SessionMeta[] } }
```

### `session.create`

创建新的 chat session。

```ts
// 请求
{
  type: 'rpc', id,
  method: 'session.create',
  params: {
    tool: 'claude' | 'gemini';
    model?: string;
    agentArgs?: string[];
  }
}

// 成功响应
{ type: 'rpc-response', id, result: { session: SessionMeta } }

// 失败响应（超出上限或参数错误）
{ type: 'rpc-response', id, error: 'session limit reached (max 10)' }
{ type: 'rpc-response', id, error: 'tool must be "claude" or "gemini"' }
```

创建成功后，agent 也会主动推送一条 `sessions` 消息（含新完整列表）。

### `session.close`

关闭 chat session：中止子进程、从列表移除。

```ts
// 请求
{ type: 'rpc', id, method: 'session.close', params: { sessionId: string } }

// 响应
{ type: 'rpc-response', id, result: { ok: boolean } }  // ok=false 表示不存在
```

关闭成功后，agent 也会主动推送一条 `sessions` 消息。

### `session.abort`

中止指定 chat session 当前正在运行的 agent turn，但**不关闭 session**。

```ts
// 请求
{ type: 'rpc', id, method: 'session.abort', params: { sessionId: string } }

// 响应
{ type: 'rpc-response', id, result: { ok: true } }
```

### `session.replay`

主动请求某个 chat session 从 `fromSeq`（不含）开始的全部事件；agent 会通过 `message` 逐条推送，最后回 `rpc-response` 告知本次推送条数。

```ts
// 请求
{
  type: 'rpc', id,
  method: 'session.replay',
  params: { sessionId: string; fromSeq?: number }  // 缺省 = -1（全量）
}

// 响应（在推送完全部 delta 之后发送）
{ type: 'rpc-response', id, result: { ok: true, count: number } }
```

### `session.permissionResponse`

响应 Gemini 权限请求（见第 9 节）。

```ts
// 请求
{
  type: 'rpc', id,
  method: 'session.permissionResponse',
  params: {
    sessionId: string;
    permissionId: string;
    approved: boolean;
  }
}

// 响应
{ type: 'rpc-response', id, result: { ok: true } }
```

### `getLogs`

获取 CLI serve 日志（与 chat session 无关，按 connection 作用域）。

```ts
// 请求
{ type: 'rpc', id, method: 'getLogs', params: { lines?: number } }

// 响应（成功）
{ type: 'rpc-response', id, result: { lines: string[]; logPath: string } }

// 响应（失败）
{ type: 'rpc-response', id, result: { lines: []; logPath: string } }
```

### 未知方法

```ts
{ type: 'rpc-response', id, error: 'unknown method: <method>' }
```

---

## 11. SessionStore 与 Delta Sync（per-chat-session）

**每个 chat session 拥有独立的 SessionStore**（循环缓冲，默认 200 条）和独立的 `seq` 计数器。重连时按 session 分别取 delta。

**消息空间是统一的（按 chat session 内）**：agent 自身产生的事件 和 webapp 发来的 `input`（被 agent 包装为 `{ type: 'user', message: { role: 'user', content } }` 事件）共享同一个 chat session 的 `seq` 空间，按时间顺序单调递增。这与聊天工具（IM）一致——每条消息都有唯一编号，重连时 delta 可取回完整双向聊天记录。

```
// 每个 SessionEntry 各自持有：
append(payload)
  └─ seq = nextSeq++
     entries.push({seq, payload})
     if entries.length > 200: entries.shift()  // 淘汰最旧
     return seq

getDelta(fromSeq)
  └─ entries.filter(e => e.seq > fromSeq)
     // fromSeq = -1 → 返回全部
     // fromSeq = 5  → 返回 seq 6, 7, 8, ...
     // fromSeq 超出缓冲区范围 → 返回现有全部（静默丢弃间隙）
```

**Webapp 侧维护 `lastSeqs: Record<chatSessionId, number>`**，每次收到 `message` 后更新对应 key 并持久化到 `storage.saveCredentials({...stored, lastSeqs})`，重连时随 `hello` 发送。

---

## 11.5 Chat Session 持久化（agent 端）

**SessionStore（事件流）是进程内的**（agent 重启即丢失），但 **chat session 的 metadata 和 CLI resume 凭据会持久化到磁盘**，让 `cowork-agent serve` 重启后仍能恢复之前打开的聊天框，并让 CLI 子进程以 `--resume` / `session/load` 续接上次对话。

### 磁盘布局

```
~/.cowork-agent/
├── serve-keys.json          # CLI 身份 + 连接级 sessionId（见 §12）
├── sessions/                # ← 每个 chat session 一个 JSON 文件
│   ├── <chatSessionId>.json
│   ├── <chatSessionId>.json
│   └── ...
└── logs/
```

> 注：老版本只有一个 `serve-state.json`（形如 `{geminiSessionId, cwd}`），天然只能存一个 session，已被废弃。agent 启动时会自动清理残留的 `serve-state.json`。

### 每个 session 文件字段

```ts
{
  id: string;                         // chat sessionId（= 文件名）
  tool: 'claude' | 'gemini';
  model: string | undefined;
  cwd: string;                        // 创建时的工作目录（用于过滤）
  createdAt: number;                  // Date.now()
  agentArgs: string[];                // CLI 额外参数（透传给子进程）
  claudeSessionId: string | null;     // claude --resume <id>
  geminiSessionId: string | null;     // Gemini ACP session/load <id>
}
```

**cwd 过滤**：启动时 `loadAllSessions(sessionsDir, process.cwd())` 只载入 `cwd === process.cwd()` 的 session——在别的目录启动 `cowork-agent` 不会串到本目录的会话上，也不会错误地把 `--resume` 指向另一个 repo 的 Claude 会话。其他目录的文件保留在磁盘上，由各自的启动实例各自 rehydrate。

### 写入时机

| 事件 | 行为 |
|------|------|
| `SessionManager.create()` | 写新文件（`claudeSessionId` 和 `geminiSessionId` 均为 null） |
| Claude 子进程首次报 `session_id` | 更新文件，填入 `claudeSessionId` |
| Gemini ACP `session/new` 或 `session/load` 返回 id | 更新文件，填入 `geminiSessionId` |
| `SessionManager.close()` | 删除文件 |
| `SessionManager.dispose()` | **不**删除文件（用于下次 rehydrate） |

### 启动流程

```
cowork-agent serve 启动
  ↓
loadAllSessions(sessionsDir, cwd)  →  [PersistedSession, ...]
  ↓
manager.rehydrate(restored)
  ├─ 每个恢复的 session 重建一个 SessionEntry（空的 SessionStore + 原有 CLI ids）
  └─ Gemini session 构造时传 resumeSessionId，首次 sendPrompt 时尝试 session/load
  ↓
startWsServer(...)
  ↓
如果 restored.length === 0：按 CLI flags 自动创建一个新 session
否则：跳过自动创建（由恢复的 session 负责 `cowork-agent --gemini` 仍可用的语义）
```

重连时 webapp 在 `welcome.sessions` 里看到这些恢复的 session，每个 session 的 `currentSeq` 是 `-1`（事件流是空的，因为进程刚起），webapp 通过按 session 的 `lastSeqs` 发 `hello` 触发 replay——replay 结果也是空，但是 session **仍然存在且可用**，用户在 session 里发消息时 Claude/Gemini 子进程会续接原来的对话。

---

## 12. 认证与加密

### 密钥体系

| 密钥 | 生成方 | 用途 |
|------|--------|------|
| CLI Ed25519 keypair | CLI 启动时生成 | 签发 session credential |
| Webapp Ed25519 keypair | Webapp 本地生成 | 绑定到 credential，标识设备 |

算法：TweetNaCl `sign.keyPair()`（Ed25519）。

### Session Credential 格式

```ts
// payload（JSON 序列化后签名）
{
  webappPublicKey: string;  // Base64，来自 webapp
  sessionId: string;        // Connection sessionId（来自 QR）
  expiry: number;           // Date.now() + 30天
}

// credential（最终格式，存入 localStorage）
{
  payload: string;     // JSON.stringify(payload)
  signature: string;   // Base64(Ed25519 签名)
}
```

### 有效期

| 令牌 | 有效期 | 说明 |
|------|--------|------|
| QR nonce | 5 分钟 | 防止 QR 被截获后重放 |
| Session credential | 30 天 | 断线重连无需重扫 QR |

### 混合内容限制

若 webapp 通过 `https://` 加载，浏览器会阻止 `ws://` 连接（mixed content），必须使用 `wss://`。CLI 会在 QR 展示时输出 endpoint，webapp 侧也会在连接失败时给出明确的错误提示。

---

## 13. 心跳

CLI 每 30 秒向当前连接的 client 发送 `ping`，webapp 收到后立即回复 `pong`。若连接断开，CLI 侧清除计时器；webapp 侧通过 `ws.onclose` 触发重连逻辑（不依赖心跳超时判活）。

---

## 14. 单客户端限制

CLI 同一时间只允许一个 webapp 连接。新连接到达时，CLI 会强制关闭旧连接（`ws.close(1000, 'replaced')`），然后完成新连接的握手。Chat session 的 AI 子进程**不受客户端切换影响**——它们属于 connection / SessionManager，webapp 断开期间 session 继续运行，重连时通过 delta sync 补齐事件。

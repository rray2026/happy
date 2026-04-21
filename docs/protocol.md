# Wire Protocol

`cowork-agent` 启动嵌入式 WebSocket 服务器，`cowork-webapp` 扫 QR 直连。本文档描述两者之间的全部通信协议。

相关源码：
- Agent：`packages/cowork-agent/src/`（`schemas.ts` / `types.ts` / `wsServer.ts` / `auth.ts` / `sessionStore.ts` / `serve.ts`）
- Webapp：`packages/cowork-webapp/src/directSocket.ts`

---

## 1. 协议阶段

协议由两个严格分离的阶段组成，每条 WebSocket 连接都从 Phase 1 开始，握手成功后才进入 Phase 2。

| 阶段 | 允许的入站消息 | 允许的出站消息 | 退出条件 |
|---|---|---|---|
| **Phase 1: 握手** | `hello`（首次或重连，二选一） | `welcome`（成功）/ `error` + close（失败） | 成功 → 进入 Phase 2；失败 → 连接关闭 |
| **Phase 2: 会话** | `input` / `rpc` / `pong` | `message` / `rpc-response` / `ping` / `error` + close | 连接关闭 |

**严格校验**：agent 侧入站消息一律用 Zod schema 校验（见 `schemas.ts`）。任何不符合当前阶段 schema 的消息（包括跨阶段消息、额外字段、类型错误）一律回 `error` 并 `close`。这意味着：

- Phase 1 只接受两种 `hello` shape；发 `input` / `rpc` / `pong` → `'expected hello message'` + close。
- Phase 2 不再接受 `hello`；重新认证必须重连。
- 所有消息对象都是 `strict` 模式，多余字段会被拒绝（防止注入）。

## 2. 消息类型一览

### Webapp → Agent

| type | 阶段 | 触发时机 |
|---|---|---|
| `hello` | Phase 1 | 连接建立后立即发送（首次扫码或带 credential 重连） |
| `input` | Phase 2 | 用户发送消息给 agent（agent 会入 store 分配 seq 并回显，像 IM 一样记录用户侧发言） |
| `rpc` | Phase 2 | 调用 agent 侧方法 |
| `pong` | Phase 2 | 响应 agent 的 `ping` |

### Agent → Webapp

| type | 阶段 | 触发时机 |
|---|---|---|
| `welcome` | Phase 1 末 | 握手验证通过 |
| `error` | 任意 | 握手失败 / schema 校验失败 / JSON 错误；发出后立即 `close` |
| `message` | Phase 2 | 广播 agent 事件（延续 seq） |
| `ping` | Phase 2 | 每 30 秒心跳 |
| `rpc-response` | Phase 2 | 响应 webapp 的 RPC 请求 |

完整消息结构（字段语义、校验规则、JSON 示例）见独立文档 [messages.md](messages.md)。

---

## 3. 首次连接握手

```
CLI                                          Webapp
────────────────────────────────────────────────────────────────

generateCliKeys()                            扫描 QR 码
buildQRPayload(endpoint, keys, sessionId)    解析 qrPayload
displayQRCode(qrJson)

startWsServer(port=4000)
                                             new WebSocket(endpoint)
                                             ←── ws.onopen

                                ←── { type:'hello',
                                       nonce: qrPayload.nonce,
                                       webappPublicKey: Base64(...) }

verifyNonce(nonce, qrPayload.nonce, nonceExpiry)
  ├─ Date.now() > nonceExpiry ? → close('nonce expired or invalid')
  └─ nonce !== qrPayload.nonce ? → close('nonce expired or invalid')

issueCredential(webappPublicKey, sessionId, signSecretKey)

──► { type:'welcome',
       sessionId,
       currentSeq: store.getCurrentSeq(),
       sessionCredential }

──► { type:'message', seq:0, payload:... }   // delta（从头发送）
──► { type:'message', seq:1, payload:... }
    ...

                                             收到 welcome → 存储 sessionCredential
                                             setStatus('connected')
```

---

## 4. 重连握手

```
CLI                                          Webapp
────────────────────────────────────────────────────────────────

                                             TokenStorage.getDirectCredentials()
                                             ← { endpoint, cliPublicKey,
                                                 sessionCredential, lastSeq, ... }

                                             new WebSocket(endpoint)
                                             ←── ws.onopen

                                ←── { type:'hello',
                                       sessionCredential,
                                       webappPublicKey,
                                       lastSeq: 5 }

verifyCredential(credential, signPublicKey)
  ├─ 验证 Ed25519 签名
  ├─ Date.now() > payload.expiry ? → close('invalid credential')
  └─ payload.sessionId !== sessionId ? → close('invalid credential')

──► { type:'welcome',
       sessionId,
       currentSeq: 8,
       sessionCredential }

──► { type:'message', seq:6, payload:... }   // getDelta(5) → seq > 5
──► { type:'message', seq:7, payload:... }
──► { type:'message', seq:8, payload:... }

                                             更新 lastSeq = 8
                                             setStatus('connected')
```

重连策略（webapp 侧）：指数退避，初始 1s，最大 30s。

---

## 5. QR Payload 结构

```ts
interface DirectQRPayload {
  type: 'direct';
  endpoint: string;           // WebSocket 地址，如 "ws://192.168.1.100:4000"
  cliSignPublicKey: string;   // Base64(CLI Ed25519 公钥)，用于验证 credential 签名
  sessionId: string;          // UUID
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

## 6. Agent 事件 Payload

`message.payload` 的内容取决于 agent 类型。

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
// 文本输出（accumulated after idle）
{
  type: 'assistant';
  message: { role: 'assistant'; content: [{ type: 'text'; text: string }] }
}

// 工具调用
{
  type: 'assistant';
  message: { role: 'assistant'; content: [{ type: 'tool_use'; id: string; name: string; input: unknown }] }
}

// Turn 结束（serve.ts 在 session/prompt 完成后广播）
{ type: 'result'; subtype: 'success'; result: 'Done' }

// 权限请求（Gemini 专属，见第 7 节）
{
  type: 'permission-request';
  permissionId: string;   // UUID，用于 permissionResponse RPC 关联
  toolName: string;       // 工具名，如 'bash'
  input: unknown;         // 工具调用参数
}
```

---

## 7. 权限请求流程（Gemini）

Gemini 执行工具前会向 CLI 发起 `session/request_permission` ACP 请求，CLI 将其转发到 webapp。

```
Gemini                CLI                              Webapp
──────────────────────────────────────────────────────────────────

──► session/request_permission
      {toolCall: {title:'bash',...}, options:[...]}

    生成 permissionId = randomUUID()
    permissionPending.set(permissionId, resolve)
    broadcast({
      type: 'permission-request',
      permissionId,
      toolName: 'bash',
      input: toolCall
    })

                                  收到 message.payload.type === 'permission-request'
                                  显示对话框：工具名 + 参数 + [允许]/[拒绝]

                                  用户点击 [允许]

                      ←── { type:'rpc', id:'xxx',
                              method:'permissionResponse',
                              params:{ permissionId, approved: true } }

    resolver = permissionPending.get(permissionId)
    resolver(true)
    sendRpcResponse(id, {ok:true})

                                  ──► { type:'rpc-response', id:'xxx', result:{ok:true} }

    write({jsonrpc:'2.0', id:msgId,
           result:{optionId:'proceed_always'}})  // 或 'cancel'

◄── result: {optionId: 'proceed_always'}
    继续执行工具
```

---

## 8. RPC 方法

所有 RPC 调用均为 webapp → CLI 方向，30 秒超时。

### `abort`

终止当前正在运行的 agent（Claude 子进程或 Gemini ACP session）。

```ts
// 请求
{ type: 'rpc', id, method: 'abort', params: {} }

// 响应
{ type: 'rpc-response', id, result: { ok: true } }
```

### `permissionResponse`

响应 Gemini 权限请求（见第 7 节）。

```ts
// 请求
{
  type: 'rpc', id,
  method: 'permissionResponse',
  params: { permissionId: string; approved: boolean }
}

// 响应
{ type: 'rpc-response', id, result: { ok: true } }
```

### `getLogs`

获取 CLI serve 日志。

```ts
// 请求
{
  type: 'rpc', id,
  method: 'getLogs',
  params: { lines?: string }  // 默认 '200'
}

// 响应（成功）
{
  type: 'rpc-response', id,
  result: { lines: string[]; logPath: string }
}

// 响应（失败）
{ type: 'rpc-response', id, error: 'log file not found' }
```

### 未知方法

```ts
{ type: 'rpc-response', id, error: 'unknown method: <method>' }
```

---

## 9. SessionStore 与 Delta Sync

CLI 使用循环缓冲区（默认 200 条）保存所有广播事件，支持断线重连后的增量同步。

**消息空间是统一的**：agent 自身产生的事件 和 webapp 发来的 `input`（被 agent 包装为 `{ type: 'user', message: { role: 'user', content } }` 事件）共享同一 `seq` 空间，按时间顺序单调递增。这与聊天工具（IM）一致——每条消息都有唯一编号，重连时 delta 可取回完整双向聊天记录。

```
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

**Webapp 侧维护 `lastSeq`**，每次收到 `message` 后更新并持久化到 `localStorage`，重连时随 `hello` 发送。

---

## 10. 认证与加密

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
  sessionId: string;        // 来自 QR
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

## 11. 心跳

CLI 每 30 秒向当前连接的 client 发送 `ping`，webapp 收到后立即回复 `pong`。若连接断开，CLI 侧清除计时器；webapp 侧通过 `ws.onclose` 触发重连逻辑（不依赖心跳超时判活）。

---

## 12. 单客户端限制

CLI 同一时间只允许一个 webapp 连接。新连接到达时，CLI 会强制关闭旧连接（`ws.close(1000, 'replaced')`），然后完成新连接的握手。

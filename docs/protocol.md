# Wire Protocol

`cowork-agent` 启动嵌入式 WebSocket 服务器，`cowork-webapp` 扫 QR 直连。本文档描述两者之间的全部通信协议。

相关源码：
- Agent：`packages/cowork-agent/src/`（`types.ts` / `wsServer.ts` / `auth.ts` / `sessionStore.ts` / `serve.ts`）
- Webapp：`packages/cowork-webapp/src/directSocket.ts`

---

## 1. 消息类型一览

### Webapp → CLI

| type | 触发时机 |
|------|----------|
| `hello` | 连接建立后立即发送（首次或重连） |
| `input` | 用户发送消息给 agent |
| `rpc` | 调用 CLI 侧方法 |
| `pong` | 响应 CLI 的 ping |

### CLI → Webapp

| type | 触发时机 |
|------|----------|
| `welcome` | 握手验证通过后 |
| `message` | 广播 agent 输出事件 |
| `error` | 握手验证失败 |
| `ping` | 每 30 秒心跳 |
| `rpc-response` | 响应 webapp 的 RPC 请求 |

---

## 2. 完整消息结构

### Webapp → CLI

```ts
// 首次连接
{
  type: 'hello';
  nonce: string;           // Base64(32字节随机数，来自 QR payload)
  webappPublicKey: string; // Base64(webapp Ed25519 公钥)
}

// 重连
{
  type: 'hello';
  sessionCredential: string;  // JSON: {payload, signature}，由首次握手签发
  webappPublicKey: string;    // 与首次相同的公钥
  lastSeq: number;            // webapp 已收到的最后 seq（初次重连传 -1）
}

// 发送 agent 输入
{
  type: 'input';
  text: string;
}

// RPC 调用
{
  type: 'rpc';
  id: string;       // 唯一 ID（UUID 推荐）
  method: string;
  params: unknown;
}

// 心跳响应
{ type: 'pong' }
```

### CLI → Webapp

```ts
// 握手成功
{
  type: 'welcome';
  sessionId: string;           // 本次 serve 会话的 UUID
  currentSeq: number;          // store 当前最大 seq（空时为 -1）
  sessionCredential: string;   // 供重连使用，存入 localStorage
}

// Agent 输出事件（所有广播内容均通过此消息传递）
{
  type: 'message';
  seq: number;        // 单调递增序列号（从 0 开始）
  payload: unknown;   // agent 事件对象（见第 6 节）
}

// 握手失败
{
  type: 'error';
  message: string;   // 'nonce expired or invalid' | 'invalid credential'
}

// 心跳
{ type: 'ping' }

// RPC 响应
{
  type: 'rpc-response';
  id: string;        // 对应 RPC 请求的 id
  result?: unknown;  // 成功时有值
  error?: string;    // 失败时有值
}
```

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

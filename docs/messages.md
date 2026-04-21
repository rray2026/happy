# Message Reference

`cowork-webapp` 与 `cowork-agent` 之间通过单一 WebSocket 连接传输 JSON 消息。协议分为两个严格分离的阶段（**Phase 1 握手 / Phase 2 会话**），且每条消息的 `sessionId` 会明确指向某个 chat session（可以理解为"某个聊天框"）。详见 [protocol.md](protocol.md)。本文档列出每条消息的**完整字段定义、语义、校验规则和 JSON 示例**。

- 编码：UTF-8 JSON，由 `JSON.stringify` 生成，每个 WebSocket 帧恰好一条消息。
- 方向：所有消息都是单向的，没有请求 / 响应语义（除了 `rpc` ↔ `rpc-response`）。
- **入站消息严格校验**：agent 侧用 Zod schema 校验（`packages/cowork-agent/src/schemas.ts`），不符合当前阶段 schema 的消息一律 `error` + close。
- Agent 源码：`schemas.ts`（入站 schema）、`types.ts`（出站类型）、`sessionManager.ts`（chat session 生命周期）
- Webapp 源码：`packages/cowork-webapp/src/session/events.ts`、`session/client.ts`

> **两种 sessionId**：协议里的 `sessionId` 根据上下文有两个含义——
> - **Connection sessionId**：QR payload 和 credential 里的那个，标识一次 cowork-agent serve 进程；只在 welcome / credential / QR 中出现。
> - **Chat sessionId**：`message` / `input` / `sessions.*` RPC 里的那个，标识一个聊天框；一个 connection 可有多个。
>
> 下文每处都会注明是哪一个。

---

## 1. 消息类型一览

### Webapp → Agent

| type | 阶段 | 用途 |
|---|---|---|
| `hello` | Phase 1 | 握手（首次扫码 / 重连） |
| `input` | Phase 2 | 向某个 chat session 发送用户输入 |
| `rpc` | Phase 2 | 调用 agent 侧方法 |
| `pong` | Phase 2 | 响应 agent 的 `ping` 心跳 |

### Agent → Webapp

| type | 阶段 | 用途 |
|---|---|---|
| `welcome` | Phase 1 末 | 握手成功的确认；附带当前全部 chat session 快照 |
| `error` | 任意 | 握手 / 校验失败，之后立即 `close` |
| `message` | Phase 2 | 广播某个 chat session 的事件（带 `sessionId` + `seq`） |
| `sessions` | Phase 2 | chat session 列表变化时推送最新快照 |
| `rpc-response` | Phase 2 | 回应 webapp 的 `rpc` 请求 |
| `ping` | Phase 2 | 每 30 秒心跳 |

---

## 2. Webapp → Agent

### `hello`（首次握手）

Webapp 首次扫描 QR 后发送，使用 QR 里的 nonce 证明"刚才在场"。

```ts
{
  type: 'hello';
  nonce: string;            // QR payload 中的 nonce（Base64 32 字节随机数）
  webappPublicKey: string;  // webapp 生成的 Ed25519 公钥，Base64
}
```

| 字段 | 类型 | 要求 |
|---|---|---|
| `nonce` | Base64 string | 必须与 QR 里的 `nonce` 完全一致，未过期（5 分钟 TTL），且未被消费 |
| `webappPublicKey` | Base64 string | 32 字节 Ed25519 公钥，webapp 本地生成，用于后续 credential 签名绑定 |

**校验失败行为**：agent 回 `{ type: 'error', message: 'nonce expired or invalid' }` 然后 `close`。

**nonce 是一次性的**：握手成功后立刻失效，即使在 5 分钟 TTL 内也不能再用。

**示例**：

```json
{
  "type": "hello",
  "nonce": "b3bTqRkXF5dDYUlq6QfJ1qKq9Km/HgtMzBocr2Xr1cI=",
  "webappPublicKey": "tUxOTQzZGYtNjkxOC00NGZhLTg2MDUtZWMxMDVlMDg0Y2U5"
}
```

### `hello`（重连）

Webapp 已持有 30 天 session credential 时使用，免扫码。

```ts
{
  type: 'hello';
  sessionCredential: string;            // 首次握手 agent 签发的 credential（JSON 字符串）
  webappPublicKey: string;              // 必须与 credential payload 内的 webappPublicKey 一致
  lastSeqs: Record<string, number>;     // per-chat-session 已收到的最后 seq；首次重连传 {}
}
```

| 字段 | 类型 | 要求 |
|---|---|---|
| `sessionCredential` | JSON string | 由 CLI 公钥验证签名；payload.sessionId 必须匹配当前 connection sessionId |
| `webappPublicKey` | Base64 string | 32 字节 Ed25519 公钥 |
| `lastSeqs` | object | key = chat sessionId，value = 该 session 已收到的最大 seq。未出现的 session 默认按 `-1` 全量回放 |

**校验失败行为**：agent 回 `{ type: 'error', message: 'invalid credential' }` 然后 `close`。Webapp 收到后应清除本地凭证并提示重新扫码。

**`lastSeqs` 的值**：持久化在 `localStorage.cowork_direct_creds.lastSeqs`，webapp 每收到一条 `message` 就更新对应 key。

**示例**（`sessionCredential` 字段是 JSON 字符串，内部结构见 [protocol.md §12](protocol.md#12-认证与加密)）：

```json
{
  "type": "hello",
  "sessionCredential": "{\"payload\":\"{\\\"webappPublicKey\\\":\\\"...\\\",\\\"sessionId\\\":\\\"...\\\",\\\"expiry\\\":1764547200000}\",\"signature\":\"3w2b...\"}",
  "webappPublicKey": "tUxOTQzZGYt...",
  "lastSeqs": {
    "chat-abc-...": 5,
    "chat-def-...": 12
  }
}
```

### `input`

用户在 webapp 某个聊天框里发送的一条消息。Agent 会做两件事：

1. **记录并编号**：把这条用户消息作为一个 `user` 事件追加到**对应 chat session 的** SessionStore，分配一个 `seq`，并立刻通过 `message` 帧回显给发送方。这就像 IM（微信/Slack）里"自己发的消息也进消息流"——编号连续、可重放、重连也能看到历史。
2. **交给 agent**：把 `text` 写入该 chat session 的 agent stdin（Claude 子进程或 Gemini ACP 的 `session/prompt`），触发一次 agent turn。

```ts
{
  type: 'input';
  sessionId: string;   // Chat sessionId：目标聊天框
  text: string;        // 原始文本，不做任何转义 / markdown 解析
}
```

| 字段 | 类型 | 要求 |
|---|---|---|
| `sessionId` | string | 必须是当前 connection 上存活的 chat session id；否则 agent 侧会抛错但不 close 连接 |
| `text` | UTF-8 string | 非空字符串 |

**回显消息格式**（webapp 会收到的 `message.payload`，`message.sessionId` 与 input 的 sessionId 一致）：

```json
{ "type": "user", "message": { "role": "user", "content": "帮我写一个快排。" } }
```

这与 Claude CLI 的 user event 同形，`eventToItems` 直接识别为 `kind: 'user'` 条目。若 Claude 随后也回显一个 user event 且文本一致，`mergeItems` 里的"相邻重复 user 去重"规则会自动合并。

**agent 忙时的行为**：若该 session 上一次 turn 尚未结束，agent 仍会**记录并回显**用户消息（用户看到自己说的话进入聊天记录），但在日志里记录 `ignored input — agent busy` 并不触发新的 agent turn。建议 webapp UI 侧禁用对应聊天框的输入框直到该 session 的 `result` 出现。

**示例**：

```json
{ "type": "input", "sessionId": "chat-abc-...", "text": "帮我写一个快排。" }
```

### `rpc`

调用 agent 侧的命名方法，有请求 / 响应语义。

```ts
{
  type: 'rpc';
  id: string;         // webapp 本地生成的唯一 ID（推荐 UUID）
  method: string;     // 见 protocol.md §10
  params: unknown;    // 方法相关，部分方法需要 sessionId（chat session）
}
```

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | string | webapp 需保证短期内唯一以匹配响应 |
| `method` | string | 见支持方法列表 |
| `params` | JSON 任意值 | 因方法而异，可省略时应传 `{}` 或 `null` |

**响应**：agent 会回复一条 `rpc-response`，`id` 与请求一致。Webapp 侧在 30 秒内未收到响应应当做超时处理。

**示例**（创建一个新的 claude 聊天框）：

```json
{
  "type": "rpc",
  "id": "8c2b...",
  "method": "session.create",
  "params": { "tool": "claude", "model": "sonnet" }
}
```

### `pong`

对 agent `ping` 的回应。Agent 目前**不检查**是否收到 `pong`（断开检测依赖 `ws.onclose`），所以即使 webapp 不发 pong 也不会被踢掉，但建议遵循协议。

```ts
{ type: 'pong' }
```

---

## 3. Agent → Webapp

### `welcome`

握手成功的最后一步。发送此消息之后，agent 依次对 `welcome.sessions` 里的每个 chat session 做 delta 回放（首次握手按 `-1` 全量、重连按 `hello.lastSeqs[sid]`）。

```ts
{
  type: 'welcome';
  sessionId: string;           // Connection sessionId（= QR payload 里的 sessionId）
  sessionCredential: string;   // 首次握手 = 新签发；重连 = 回显
  sessions: SessionMeta[];     // 本 connection 上当前全部 chat session
}

interface SessionMeta {
  id: string;               // Chat sessionId
  tool: 'claude' | 'gemini';
  model: string | undefined;
  cwd: string;              // agent 启动目录
  createdAt: number;        // Unix ms
  currentSeq: number;       // 该 session SessionStore 当前最大 seq；空时为 -1
}
```

**Webapp 收到后**：
1. 持久化 `sessionCredential`、`cliSignPublicKey`、`endpoint` 到 `localStorage.cowork_direct_creds`
2. 把 `sessions` 设为本地 chat session 列表，触发 `onSessionsChange` 订阅者（侧边栏刷新）
3. 状态改为 `connected`
4. 准备接收后续 `message`（会按 session 分别 delta 回放）

**示例**：

```json
{
  "type": "welcome",
  "sessionId": "2c9e...",
  "sessionCredential": "{\"payload\":\"...\",\"signature\":\"...\"}",
  "sessions": [
    {
      "id": "chat-abc-...",
      "tool": "claude",
      "model": null,
      "cwd": "/Users/alice/project",
      "createdAt": 1764400000000,
      "currentSeq": 8
    },
    {
      "id": "chat-def-...",
      "tool": "gemini",
      "model": null,
      "cwd": "/Users/alice/project",
      "createdAt": 1764400050000,
      "currentSeq": -1
    }
  ]
}
```

### `message`

Agent 把一个 chat session 里产生的所有事件（工具调用、思考、文本、结果）以及**用户自己发来的 `input` 消息**都通过 `message` 包装后广播。每条 `message` 带 `sessionId`（chat session），并只进入该 session 自己的 SessionStore / seq 空间。

**类比聊天工具**：不论是"我说的"还是"对方（agent）说的"，每条消息都在**该聊天框内**分配一个全局编号，像 IM 里的 messageId。重连时按 `lastSeqs[sid]` 做 delta 即可补齐每个聊天框的完整历史，不会丢掉用户自己发过的话。

```ts
{
  type: 'message';
  sessionId: string;   // Chat sessionId：这条事件属于哪个聊天框
  seq: number;         // 该 chat session 内的单调递增 seq（从 0 开始）
  payload: unknown;    // agent 事件对象，见 protocol.md §8
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | string | 必须在 webapp 本地 sessions 列表中存在；否则 webapp 可忽略（通常意味着列表变化消息还没到） |
| `seq` | int ≥ 0 | **chat session 内**严格递增。不保证跨 session 有序 |
| `payload` | 任意 JSON | 形式与该 session 的 agent 类型相关（Claude stream-json / Gemini ACP 转换后） |

**顺序保证**：agent 对**同一 chat session** 按 `seq` 升序发送；跨 session 的消息可任意交错。webapp 若收到 `seq` 小于等于当前 `lastSeqs[sid]` 的消息，应忽略（用于幂等 / 重放容错）。

**缓冲区溢出**：若 webapp 的 `lastSeqs[sid]` 早于 agent 该 session 缓冲区最旧项（即该 session 运行太久、累积超过 200 条后重连），agent **只发现有的，不提醒丢失**。Webapp 侧 UI 可能出现该聊天框的会话历史不完整。

**示例**（一次 Claude 工具调用）：

```json
{
  "type": "message",
  "sessionId": "chat-abc-...",
  "seq": 3,
  "payload": {
    "type": "tool_use",
    "id": "toolu_01...",
    "name": "Read",
    "input": { "file_path": "/tmp/foo.ts" }
  }
}
```

### `sessions`

每当 chat session 列表发生变化（`session.create` 成功、`session.close` 成功、或未来其他变动），agent 会主动推送一条 `sessions` 消息，内含当前完整 chat session 列表。Webapp 用它刷新侧边栏。

```ts
{
  type: 'sessions';
  sessions: SessionMeta[];
}
```

**示例**（刚创建了一个 gemini 聊天框后）：

```json
{
  "type": "sessions",
  "sessions": [
    { "id": "chat-abc-...", "tool": "claude", "model": null, "cwd": "/x", "createdAt": 1764400000000, "currentSeq": 8 },
    { "id": "chat-xyz-...", "tool": "gemini", "model": null, "cwd": "/x", "createdAt": 1764400120000, "currentSeq": -1 }
  ]
}
```

### `rpc-response`

对 webapp `rpc` 请求的响应。`result` 和 `error` 互斥：有 `error` 即失败。

```ts
{
  type: 'rpc-response';
  id: string;         // 与请求的 id 一致
  result?: unknown;   // 成功时返回值
  error?: string;     // 失败时错误描述
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 与原 `rpc` 的 `id` 字符串完全一致 |
| `result` | 任意 JSON | 成功时返回；`undefined` / 缺省 = 无返回值 |
| `error` | string | 失败时设置；典型值如 `'unknown method: X'`、`'session limit reached (max 10)'`、`'sessionId required'` |

**示例**：

```json
{ "type": "rpc-response", "id": "8c2b...", "result": { "session": { "id": "chat-xyz-...", "tool": "claude", "model": null, "cwd": "/x", "createdAt": 1764400120000, "currentSeq": -1 } } }
```

```json
{ "type": "rpc-response", "id": "4a9d...", "error": "unknown method: foobar" }
```

### `ping`

Agent 每 30 秒主动发一次（握手成功后开始计时）。Webapp 收到后应尽快回 `pong`。

```ts
{ type: 'ping' }
```

### `error`

只在握手失败或入站消息 schema 校验失败时发出，然后 agent 立即关闭连接。**不会**用于运行时业务错误——运行时错误通过 `message` 的 `payload.subtype: 'error'` 或 `rpc-response.error` 传递。

```ts
{
  type: 'error';
  message: string;   // 人类可读错误描述
}
```

| `message` 值 | 阶段 | 含义 |
|---|---|---|
| `'nonce expired or invalid'` | Phase 1 | QR 过期 / nonce 不匹配 / nonce 已被使用过 |
| `'invalid credential'` | Phase 1 | Credential 签名无效 / 已过期 / sessionId 不匹配 |
| `'expected hello message'` | Phase 1 | 收到的不是合法 `hello`（包括类型错 / 字段缺失 / 多余字段） |
| `'invalid session message'` | Phase 2 | 收到的不是合法 `input`/`rpc`/`pong`（包括在 Phase 2 发 `hello`） |
| `'invalid JSON'` | 任意 | 收到的帧不是合法 JSON |

**Webapp 收到后的推荐行为**：根据消息内容提示用户：
- `nonce expired or invalid` → 提示重新扫码
- `invalid credential` → 清除本地 credential 并回到扫码界面
- `invalid JSON` → 实现 bug，记录到控制台

---

## 4. 大小与性能

- **消息大小无硬限制**，但 Claude / Gemini 工具输出（尤其是文件读取）可能很大。Webapp 应做 UI 层裁剪（例如折叠超过 N 行的 `tool_result`）。
- **WebSocket 帧**默认不压缩。若后续接入 `permessage-deflate`，需客户端和服务端协商。
- **一条消息一帧**：不跨帧拆分，也不在一帧里粘多条。

## 5. 错误处理约定

| 场景 | 协议层行为 | Webapp 应对 |
|---|---|---|
| 收到无法解析的 JSON | agent 发 `error: 'invalid JSON'` 然后 close | 记录日志，回退到扫码 |
| Phase 1 发了非 `hello` 消息 | `error: 'expected hello message'` + close | 实现 bug，检查顺序 |
| Phase 2 发了 `hello` 或未知 type | `error: 'invalid session message'` + close | 重连进入新的 Phase 1 |
| 消息带了多余字段 | 同上的 schema 错误 + close | 严格按 schema 发送；不要塞额外字段 |
| RPC 调用超时 | 协议不保证；agent 可能永不回 | webapp 自行实现超时（建议 30 秒） |
| Chat session 内 agent turn 运行中收到 `input` | 静默记录 + 回显，但不触发新 turn | UI 禁用该 session 输入框直到 `result` 出现 |
| `input` 的 sessionId 指向不存在的 chat session | agent 记日志后忽略；不关闭连接 | 发送前检查本地 sessions 列表；收到 `sessions` 更新即时同步 |
| Webapp 连接丢失 | `ws.onclose` 触发 | 指数退避重连，初始 1s 最大 30s |
| 新 webapp 连接 | agent 踢旧连接（`close(1000, 'replaced')`） | 旧 webapp 收到 close code 1000 提示 `session has been taken by another device` |

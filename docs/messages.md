# Message Reference

`cowork-webapp` 与 `cowork-agent` 之间通过单一 WebSocket 连接传输 JSON 消息。协议分为两个严格分离的阶段（**Phase 1 握手 / Phase 2 会话**），详见 [protocol.md §1](protocol.md#1-协议阶段)。本文档列出每条消息的**完整字段定义、语义、校验规则和 JSON 示例**。

- 编码：UTF-8 JSON，由 `JSON.stringify` 生成，每个 WebSocket 帧恰好一条消息。
- 方向：所有消息都是单向的，没有请求 / 响应语义（除了 `rpc` ↔ `rpc-response`）。
- **入站消息严格校验**：agent 侧用 Zod schema 校验（`packages/cowork-agent/src/schemas.ts`），不符合当前阶段 schema 的消息一律 `error` + close。
- Agent 源码：`packages/cowork-agent/src/schemas.ts`（入站 schema）、`types.ts`（出站类型）
- Webapp 源码：`packages/cowork-webapp/src/session/events.ts`、`session/client.ts`

---

## 1. 消息类型一览

### Webapp → Agent

| type | 阶段 | 用途 |
|---|---|---|
| `hello` | Phase 1 | 握手（首次扫码 / 重连） |
| `input` | Phase 2 | 发送用户输入给 agent |
| `rpc` | Phase 2 | 调用 agent 侧方法 |
| `pong` | Phase 2 | 响应 agent 的 `ping` 心跳 |

### Agent → Webapp

| type | 阶段 | 用途 |
|---|---|---|
| `welcome` | Phase 1 末 | 握手成功的确认（进入 Phase 2 的信号） |
| `error` | 任意 | 握手 / 校验失败，之后立即 `close` |
| `message` | Phase 2 | 广播 agent 输出事件（带 `seq`） |
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
  sessionCredential: string;  // 首次握手 agent 签发的 credential（JSON 字符串）
  webappPublicKey: string;    // 必须与 credential payload 内的 webappPublicKey 一致
  lastSeq: number;            // webapp 已收到的最后 seq；首次重连传 -1 表示需要全量
}
```

**校验失败行为**：agent 回 `{ type: 'error', message: 'invalid credential' }` 然后 `close`。Webapp 收到后应清除本地凭证并提示重新扫码。

**`lastSeq` 的值**：持久化在 `localStorage` 的 `cowork_direct_creds.lastSeq`，webapp 每收到一条 `message` 就更新。

**示例**（`sessionCredential` 字段是 JSON 字符串，内部结构见 [protocol.md §10](protocol.md#10-认证与加密)）：

```json
{
  "type": "hello",
  "sessionCredential": "{\"payload\":\"{\\\"webappPublicKey\\\":\\\"...\\\",\\\"sessionId\\\":\\\"...\\\",\\\"expiry\\\":1764547200000}\",\"signature\":\"3w2b...\"}",
  "webappPublicKey": "tUxOTQzZGYt...",
  "lastSeq": 5
}
```

### `input`

用户在 webapp 聊天框里发送的一条消息。Agent 会做两件事：

1. **记录并编号**：把这条用户消息作为一个 `user` 事件追加到 SessionStore，分配一个 `seq`，并立刻通过 `message` 帧回显给发送方。这就像 IM（微信/Slack）里"自己发的消息也进消息流"——编号连续、可重放、重连也能看到历史。
2. **交给 agent**：把 `text` 写入当前 agent 的 stdin（Claude 子进程或 Gemini ACP 的 `session/prompt`），触发一次 agent turn。

```ts
{
  type: 'input';
  text: string;   // 原始文本，不做任何转义 / markdown 解析
}
```

| 字段 | 类型 | 要求 |
|---|---|---|
| `text` | UTF-8 string | 非空字符串 |

**回显消息格式**（webapp 会收到的 `message.payload`）：

```json
{ "type": "user", "message": { "role": "user", "content": "帮我写一个快排。" } }
```

这与 Claude CLI 的 user event 同形，`eventToItems` 直接识别为 `kind: 'user'` 条目。若 Claude 随后也回显一个 user event 且文本一致，`mergeItems` 里的"相邻重复 user 去重"规则会自动合并。

**agent 忙时的行为**：若上一次 turn 尚未结束，agent 仍会**记录并回显**用户消息（用户看到自己说的话进入聊天记录），但在日志里记录 `ignored input — agent busy` 并不触发新的 agent turn。建议 webapp UI 侧禁用输入框直到上一条 `result` 出现。

**示例**：

```json
{ "type": "input", "text": "帮我写一个快排。" }
```

### `rpc`

调用 agent 侧的命名方法，有请求 / 响应语义。

```ts
{
  type: 'rpc';
  id: string;         // webapp 本地生成的唯一 ID（推荐 UUID）
  method: string;     // 见 [protocol.md §8](protocol.md#8-rpc-方法)
  params: unknown;    // 方法相关
}
```

| 字段 | 类型 | 要求 |
|---|---|---|
| `id` | string | webapp 需保证短期内唯一以匹配响应 |
| `method` | string | 见支持方法列表 |
| `params` | JSON 任意值 | 因方法而异，可省略时应传 `{}` 或 `null` |

**响应**：agent 会回复一条 `rpc-response`，`id` 与请求一致。Webapp 侧在 30 秒内未收到响应应当做超时处理（超时值由 webapp 决定，协议本身不规定）。

**示例**：

```json
{ "type": "rpc", "id": "8c2b...", "method": "abort", "params": {} }
```

### `pong`

对 agent `ping` 的回应。Agent 目前**不检查**是否收到 `pong`（断开检测依赖 `ws.onclose`），所以即使 webapp 不发 pong 也不会被踢掉，但建议遵循协议。

```ts
{ type: 'pong' }
```

---

## 3. Agent → Webapp

### `welcome`

握手成功的最后一步。发送此消息之后，agent 立刻用 `message` 消息开始 delta 回放（从 `lastSeq` 之后到 `currentSeq`）。

```ts
{
  type: 'welcome';
  sessionId: string;           // 本次 serve 进程的 UUID；webapp 可用于判断是否同一个 serve 会话
  currentSeq: number;          // agent 本地 SessionStore 当前最大 seq；空时为 -1
  sessionCredential: string;   // 首次握手时签发；重连时 agent 回传原 credential
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | UUID string | 来自 QR payload，与本次 serve 进程绑定 |
| `currentSeq` | int | 首次握手 webapp 用此值初始化 `lastSeq` |
| `sessionCredential` | JSON string | 首次握手 = 新签发；重连 = 回显原值，webapp 可不更新 |

**Webapp 收到后**：
1. 持久化 `sessionCredential`、`cliSignPublicKey`、`endpoint` 到 `localStorage.cowork_direct_creds`
2. 状态改为 `connected`
3. 准备接收后续 `message`

**示例**：

```json
{
  "type": "welcome",
  "sessionId": "2c9e...",
  "currentSeq": 12,
  "sessionCredential": "{\"payload\":\"...\",\"signature\":\"...\"}"
}
```

### `message`

Agent 把一次 turn 里产生的所有事件（工具调用、思考、文本、结果）以及**用户自己发来的 `input` 消息**都通过 `message` 包装后广播。所有 `message` 都会进入 SessionStore 的循环缓冲（最大 200 条），共享一个全局递增的 `seq` 空间，供断线重连 delta 同步。

**类比聊天工具**：不论是"我说的"还是"对方（agent）说的"，每条消息都分配一个全局编号，像 IM 里的 messageId。这样重连时一次 delta 就能把完整聊天记录取回来，不会丢掉用户自己发过的话。

```ts
{
  type: 'message';
  seq: number;        // 单调递增从 0 开始；同一 serve 进程内唯一
  payload: unknown;   // agent 事件对象，见 [protocol.md §6](protocol.md#6-agent-事件-payload)
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | int ≥ 0 | 严格递增。不保证连续（但当前实现是连续的） |
| `payload` | 任意 JSON | 形式与 agent 类型相关（Claude stream-json / Gemini ACP 转换后） |

**顺序保证**：agent 按 `seq` 升序发送。webapp 若收到 `seq` 小于等于当前 `lastSeq` 的消息，应忽略（用于幂等 / 重放容错）。

**缓冲区溢出**：若 webapp 的 `lastSeq` 早于 agent 缓冲区最旧项（即 agent 进程运行太久、累积超过 200 条后重连），agent **只发现有的，不提醒丢失**。Webapp 侧 UI 可能出现会话历史不完整。

**示例**（一次 Claude 工具调用）：

```json
{
  "type": "message",
  "seq": 3,
  "payload": {
    "type": "tool_use",
    "id": "toolu_01...",
    "name": "Read",
    "input": { "file_path": "/tmp/foo.ts" }
  }
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
| `error` | string | 失败时设置；典型值 `'unknown method: X'` |

**示例**：

```json
{ "type": "rpc-response", "id": "8c2b...", "result": { "ok": true } }
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

只在握手失败时发出，然后 agent 立即关闭连接。**不会**用于运行时业务错误——运行时错误通过 `message` 的 `payload.subtype: 'error'` 或 `rpc-response.error` 传递。

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
| Agent turn 运行中收到 `input` | 静默丢弃 | UI 禁用输入框直到 `result` 出现 |
| Webapp 连接丢失 | `ws.onclose` 触发 | 指数退避重连，初始 1s 最大 30s |
| 新 webapp 连接 | agent 踢旧连接（`close(1000, 'replaced')`） | 旧 webapp 收到 close code 1000 提示 `session has been taken by another device` |

# Happy ↔ A2UI 合规设计

本文档对照 [A2UI v0.9 协议](https://a2ui.org/specification/v0.9-a2ui/)，分析 happy 当前 direct connect 实现的合规度，并给出向 A2UI 迁移的设计方案。

---

## 1. A2UI 协议速览

A2UI（Agent to UI）是 Google 主导的**声明式 UI 协议**：agent 不描述"发生了什么事件"，而是描述"界面应该是什么样"。客户端从一个**组件目录（catalog）**中挑选组件进行渲染，避免执行 agent 下发的任意代码。

### 1.1 核心消息类型（server → client）

每条消息是一个 JSON 对象，**必须且仅包含**以下四个 key 之一：

| 消息 | 用途 |
|------|------|
| `createSurface` | 创建新的渲染区域（surface） |
| `updateComponents` | 追加/更新 surface 中的组件 |
| `updateDataModel` | 更新 surface 的数据模型 |
| `deleteSurface` | 删除 surface |

消息均带有顶层 `version` 字段（如 `"v0.9"`）。

### 1.2 组件结构

- **扁平邻接表**：组件以平铺列表给出，父子关系通过 `id` 引用（`children` / `child`）
- **约定根节点**：必存在一个 `"id": "root"` 的组件
- **歧义消除符**：每个组件用 `"component": "Text"` 标识类型，属性直接平铺在对象上（不嵌套）
- **渐进渲染**：允许子引用暂时悬空（未到达的组件用占位符）

### 1.3 数据绑定

使用 **JSON Pointer (RFC 6901)** 将组件属性绑定到 surface 的数据模型：

```json
{ "id": "greeting", "component": "Text", "text": { "path": "/userName" } }
```

### 1.4 客户端 → 服务端（actions）

组件可声明 `action`，分两种：

- **Server event**：回传 agent，带数据上下文
- **Local function call**：客户端本地执行（如打开 URL）

```json
{
  "id": "submit-btn",
  "component": "Button",
  "child": "btn-text",
  "action": {
    "event": {
      "name": "submit_reservation",
      "context": {
        "time": { "path": "/reservationTime" },
        "size": { "path": "/partySize" }
      }
    }
  }
}
```

### 1.5 传输

JSONL over SSE（推荐）或 WebSocket。每行一个完整 JSON 对象。

### 1.6 设计哲学

| 设计选择 | 动机 |
|----------|------|
| 声明式而非命令式 | agent 不控制客户端代码，仅描述意图 |
| 组件目录外挂 | 平台自定义 UI，避免"胖协议" |
| 扁平邻接表 | LLM 生成更稳定（嵌套树易出错） |
| 单例 `root` | 无歧义的根节点约定 |
| 数据模型分离 | 组件树可复用，内容动态变化 |
| 无任意代码 | 端侧安全（浏览器/移动端同样模型） |

---

## 2. Happy 当前实现（direct connect）

参见 `docs/direct-connect-protocol.md`。

### 2.1 消息类型（server → client）

| 类型 | 用途 |
|------|------|
| `welcome` | 握手成功，下发 sessionId / credential / currentSeq |
| `message` | 广播 agent 事件（payload 为 Claude stream-json） |
| `error` | 握手失败原因 |
| `ping` | 30 秒心跳 |
| `rpc-response` | 回复 webapp 的 RPC 调用 |

### 2.2 Payload 模型

`message.payload` 是 **agent 事件流**（Claude stream-json 或 Gemini ACP 转换版）：

```ts
{ type: 'assistant', message: { role: 'assistant', content: [...] } }
{ type: 'tool_use', id, name, input }
{ type: 'tool_result', tool_use_id, content }
{ type: 'thinking', thinking }
{ type: 'result', subtype, result }
{ type: 'system', session_id }
{ type: 'permission-request', permissionId, toolName, input }
```

Webapp 把事件灌入 reducer，产出扁平 `Message[]`，用**写死的 React 组件树**渲染。

### 2.3 客户端 → 服务端

| 类型 | 用途 |
|------|------|
| `hello` | 首次握手 / 重连 |
| `input` | 用户文本输入给 agent |
| `rpc` | 调用 `abort` / `getLogs` / `permissionResponse` |
| `pong` | 心跳回应 |

---

## 3. 分层对比

**根本差异**：两个协议处于不同抽象层。

```
┌─────────────────────────────────────────────────┐
│  A2UI：agent 描述"屏幕长什么样"                 │ ← UI 层
├─────────────────────────────────────────────────┤
│  Happy：agent 描述"我做了什么"                  │ ← 事件层
├─────────────────────────────────────────────────┤
│  Transport：WebSocket / JSONL                    │ ← 传输层
└─────────────────────────────────────────────────┘
```

Happy 的 webapp 扮演了"从事件到 UI 的翻译器"，这个翻译逻辑固化在前端代码里。A2UI 把这个翻译层上移到协议里，agent 直接下发 UI 描述。

---

## 4. 合规矩阵

逐项对照 A2UI 核心要求：

| A2UI 要求 | Happy 现状 | 合规度 | 说明 |
|-----------|------------|--------|------|
| JSONL 流式传输 | 每个 `message` 是完整 JSON | ✅ 完全符合 | 实质等价 |
| WebSocket 可选传输 | 唯一传输 | ✅ 完全符合 | A2UI 允许 WS |
| 顶层 `version` 字段 | 无 | ❌ 不符合 | 未做版本协商 |
| 四种消息类型（createSurface / updateComponents / updateDataModel / deleteSurface） | 无 | ❌ 不符合 | 消息封装完全不同 |
| 组件目录（catalog） | 无 | ❌ 不符合 | Webapp UI 硬编码 |
| 扁平邻接表组件 | 无 | ❌ 不符合 | UI 由前端组件树决定 |
| `"id": "root"` 约定 | 无 | ❌ 不符合 | 无 surface 概念 |
| 数据模型 + JSON Pointer 绑定 | 无 | ❌ 不符合 | 内容直接塞入组件 props |
| 渐进渲染（悬空引用容忍） | N/A | ➖ 不适用 | 无组件树 |
| 多 surface 支持 | 无 | ❌ 不符合 | 单会话单视图 |
| 客户端 → agent 的 `action.event` | RPC + input 混用 | ⚠️ 部分符合 | 语义类似，协议不同 |
| 带 `context` 的数据回传 | RPC `params` | ⚠️ 部分符合 | 手工编码，无 JSON Pointer |
| 本地函数调用（local function call） | 无 | ❌ 不符合 | 无 agent 下发的 local action |
| 双向通信 | WebSocket 全双工 | ✅ 完全符合 | 传输能力足够 |
| 消息去重 / 幂等 | seq + lastSeq 增量同步 | ➖ A2UI 未明确 | Happy 自有机制 |

**结论**：仅**传输层**符合，**协议语义完全不兼容**。若要对接 A2UI 生态，需重构消息封装与渲染模型。

---

## 5. 迁移设计

### 5.1 目标

- 直连模式下的 webapp↔CLI 通信改造为 A2UI 兼容；
- 保留现有 direct connect 的握手、认证、delta sync、重连；
- agent 仍然是 Claude / Gemini，输出由 CLI 翻译为 A2UI 消息。

### 5.2 消息封套改造

保留 `welcome` / `ping` / `pong` 等连接层消息不变。**仅改造 agent 输出广播通道**：

```diff
  // 原：
- { type: 'message', seq, payload: { type: 'assistant', message: ... } }
  // 新：
+ { type: 'a2ui', seq, version: 'v0.9', createSurface: {...} }
+ { type: 'a2ui', seq, version: 'v0.9', updateComponents: {...} }
+ { type: 'a2ui', seq, version: 'v0.9', updateDataModel: {...} }
```

`seq` 继续由 `SessionStore` 分配，delta sync 机制不变。

### 5.3 Surface 模型

| Surface ID | 内容 |
|------------|------|
| `conversation` | 对话主流（文本、工具调用卡片） |
| `permissions` | 权限请求弹窗 |
| `status` | 头部状态栏（session_id / usage） |

### 5.4 组件目录

定义 `happy_catalog_v1.json`，包含：

- **基础**：`Column`、`Row`、`Text`、`Button`
- **对话**：`UserBubble`、`AssistantBubble`、`ThinkingBubble`
- **工具**：`ToolCard`（含 `name` / `input` / `output` / `status` 属性）
- **对话框**：`PermissionDialog`

### 5.5 事件→A2UI 消息映射

| agent 事件 | A2UI 消息 |
|-----------|-----------|
| `system { session_id }` | `createSurface` + 初始 `updateDataModel` |
| `assistant { content: [{text}] }` | `updateComponents`（追加 `AssistantBubble`）+ `updateDataModel`（文本绑定） |
| `thinking` | `updateComponents`（`ThinkingBubble`） |
| `tool_use` | `updateComponents`（新增 `ToolCard`，status=running） |
| `tool_result` | `updateDataModel`（按 `tool_use_id` 定位，写入 output）+ `updateComponents`（status=completed） |
| `result { subtype, result }` | `updateComponents`（追加状态条） |
| `permission-request` | `createSurface("permissions")` + `PermissionDialog` |

### 5.6 Action 映射

当前 RPC 语义迁移到 `action.event`：

| 现有 | A2UI 对应 |
|------|-----------|
| `rpc(permissionResponse, {permissionId, approved})` | `Button.action.event = { name: 'permission.respond', context: { permissionId: '...', approved: '...' } }` |
| `rpc(abort)` | `Button.action.event = { name: 'session.abort' }` |
| `input(text)` | 输入组件的 `action.event = { name: 'session.input', context: { text: {path: '/composer/text'} } }` |

CLI 侧接收这些 event 时，派发到原有处理器（`handleInput` / `permissionPending` / `abortController`）。

### 5.7 对比现有 event

Webapp 原 `onMessage` 分发：事件 → reducer → 组件 → 渲染

改造后：事件 → 渲染器（通用 A2UI renderer） → 组件树

渲染器可复用社区实现，Happy 仅维护 catalog 和事件翻译器。

---

## 6. 分阶段实施

| 阶段 | 工作 | 影响面 |
|------|------|--------|
| **P0** | 定义 `happy_catalog_v1.json`，冻结组件集 | CLI + webapp |
| **P1** | CLI 增加 `agentToA2ui` 翻译器（feature flag） | CLI only |
| **P2** | Webapp 引入 A2UI renderer（新路由 `/direct/a2ui`） | webapp |
| **P3** | Action 机制替换 RPC（abort / permissionResponse 先行） | 双向改造 |
| **P4** | 默认启用 A2UI 路径，旧 event 协议标记为 deprecated | 全量迁移 |
| **P5** | 删除 event 协议，清理 reducer 逻辑 | 清理 |

---

## 7. 立即可做的"完全符合"改进

在不全量迁移的前提下，以下改动成本低、收益明确：

1. **顶层 `version` 字段**：`welcome` 和 `message` 消息都加 `version: 'happy-direct-v1'`，为后续协议演进铺路。
2. **统一 action 语义**：把 `input` 和 `rpc` 合并为 `action`，语义更贴近 A2UI。
3. **消息 schema 加 `$id`**：按 A2UI 风格做 JSON Schema 验证。

---

## 8. 参考

- [A2UI v0.9 Specification](https://a2ui.org/specification/v0.9-a2ui/)
- [A2UI Concepts](https://a2ui.org/concepts/overview/)
- [A2UI Client-to-Server Actions](https://a2ui.org/concepts/client_to_server_actions/)
- Google Developers Blog: [A2UI v0.9: The New Standard for Portable, Framework-Agnostic Generative UI](https://developers.googleblog.com/a2ui-v0-9-generative-ui/)
- 本仓库 `docs/direct-connect-protocol.md`

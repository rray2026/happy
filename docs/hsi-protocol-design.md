# HSI 协议设计讨论记录

**HSI（Human Supervision Interface）**：人类监督接口协议，用于在 AI agent 自主执行过程中，让人类保持感知和介入能力。

---

## 议题 1：问题域边界

**协议定位**：Human Supervision Interface——让人类在 agent 自主执行过程中保持感知和介入能力。

类比自动驾驶：协议不是"方向盘"（主动控制），而是"仪表盘 + 接管提示"（感知异常 + 关键节点介入）。

**核心原语：Supervision Point（监督点）**

三种触发源，收敛到同一个"暂停 → 决策 → 恢复"循环：

| 触发方 | 场景 |
|--------|------|
| Agent 主动 | 遇到不确定操作，主动暂停请求审批 |
| 人类主动 | 观察到异常，主动中断 |
| 协议检查点 | 预设规则，agent 在特定节点必须等待确认 |

**核心能力（IN scope）：**
- 实时事件流（人类能看到 agent 在做什么）
- Supervision Point（暂停 → 决策 → 恢复）
- 中断（随时踩刹车）

**排除（OUT scope）：**
- 主动指挥 agent（那是 prompt 层）
- 多 agent 协作
- 复杂权限分级系统

**传输无关**：协议不区分本地/云端，拓扑对协议透明，不能假设"本地 = 可信"。

---

## 议题 2：角色与交互模型

### 角色定义

| 角色 | 说明 |
|------|------|
| **Runner** | 执行 agent 的进程，产生事件流，触发 Supervision Point |
| **Supervisor** | 接收事件流，在 Supervision Point 做决策，触发中断。协议不区分人类 / 规则引擎 / 另一个 agent |
| **Observer** | 只读，只能接收事件流，无决策权 |

### 拓扑：Channel 模型

- 每个 Runner 对应一个 **Channel**
- 每个 Channel 有且只有一个 **Active Supervisor**（决策权唯一）
- 其余连接方为 **Observer**（只读）
- 多个 Runner 分通道独立运行，Supervisor 可订阅多个 Channel

```
Channel A:  Runner ←→ Active Supervisor（决策权）
                  ←→ Observer 1（只读）
                  ←→ Observer 2（只读）

Channel B:  Runner ←→ Active Supervisor（决策权）
```

### Active Supervisor 断线处理

Supervision Point 挂起，按各自的超时策略自动处理。

**Supervision Point 数据结构：**

```json
{
  "id": "...",
  "trigger": "agent | human | policy",
  "context": { "操作类型": "...", "参数": "..." },
  "timeout": {
    "duration": 30000,
    "policy": "approve | deny | abort"
  }
}
```

每个 Supervision Point 携带独立的超时策略，不同操作策略可以不同（如删文件超时 deny，读文件超时 approve）。

### Policy

检查点规则是 **Runner 本地配置**，协议不负责 Supervisor 向 Runner 下发规则。协议只传递"这里需要决策"，不传触发原因。

---

## 议题 3：核心能力集

| 能力 | 分级 | 说明 |
|------|------|------|
| Channel 建立 / 断开 | **MUST** | 连接管理基础 |
| 重连 + Gap Fill | **MUST** | 断线后补回缺失事件 |
| 事件流推送 | **MUST** | Runner → Supervisor/Observer，协议约定格式 |
| Supervision Point | **MUST** | 暂停 → 决策 → 恢复 |
| 主动中断 | **MUST** | Supervisor 随时踩刹车 |
| Observer 支持 | **SHOULD** | 只读多人观察 |
| Runner 状态查询 | **SHOULD** | 当前是否运行中 |
| 日志查询 | **MAY** | 事后可观测性 |

**排除**：Policy 传递（Runner 本地配置，协议不感知）。

---

## 议题 4：消息设计原则

- **传输层**：不做约定，由实现决定（WebSocket / SSE / stdio 均可）
- **消息格式**：JSON-RPC 2.0
  - 握手阶段补充版本协商
  - 消息补充 `seq` 字段支持 Gap Fill
- **扩展机制**：通过命名空间扩展新消息类型
  - 协议内置：`hsi/supervision.point`、`hsi/channel.create` 等
  - 自定义扩展：`myapp/custom_event`

---

## 议题 5：安全模型

- **认证**：Token，Runner 启动时生成，带外传递（如 QR 码、URL 参数）
- **授权**：协议层定义 Active Supervisor / Observer 角色边界，Runner 强制执行；Observer 发决策消息视为非法
- **预留扩展**：Token 方案先行，密钥方案（非对称）后续可通过扩展消息类型引入

---

## 议题 6：生态对齐

### 事件流格式：采用 A2UI

事件流直接使用 **A2UI 消息格式**（`createSurface / updateComponents / updateDataModel`）。

- **Catalog 开放**：协议不强制组件目录，实现方自定义
- UI 可以完全预定义（退化为纯数据绑定），也可以完全由 agent 动态生成

**A2UI 连续谱：**

```
← UI 完全预定义                    UI 完全动态生成 →
  （agent 只填数据）                （agent 定义结构 + 填数据）
  退化的 A2UI = Happy 当前模式       完整的 A2UI
```

两端使用同一套消息格式，区别只在于 `createSurface / updateComponents` 的使用程度。

### 与现有协议的关系

| 协议 | 关系 |
|------|------|
| **MCP** | 管 agent ↔ 工具，HSI 管 human ↔ agent，互补不重叠 |
| **A2UI** | HSI 是 A2UI 的一个 profile，在其上加了 Supervision Point、Channel、Gap Fill、Token 认证 |
| **ACP（Gemini）** | HSI 传输无关，可在 ACP 之上运行 |

---

## 待讨论

- **议题 7：标准化路径**（以什么形式发布，走什么路径）
- **事件流格式与 A2UI 共用的具体设计**（A2UI catalog 与 HSI 事件类型的映射）

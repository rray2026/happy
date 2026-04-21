# cowork

本地跑 Claude Code / Gemini CLI，浏览器里用它们。一次 QR 扫码完成配对，之后点对点 WebSocket 直连，数据不经云端中转。

Fork 自 [happy-coder/happy](https://github.com/happy-coder/happy)（MIT），精简为直连场景专用版本。

## 两个包

| 包 | 作用 | 运行位置 |
|---|---|---|
| [`cowork-agent`](packages/cowork-agent) | Node 进程，桥接 Claude/Gemini CLI 与 WebSocket；启动时显示 QR | 你的开发机 |
| [`cowork-webapp`](packages/cowork-webapp) | React + Vite 浏览器 UI，通过 QR 配对后直连 agent | 浏览器（localhost 或 Cloudflare Pages） |

配对流程：agent 生成 Ed25519 密钥对 + 一次性 nonce（5 分钟失效）→ 终端打印 QR → webapp 扫码完成握手 → agent 签发 30 天 session credential，后续重连免扫码。

## 快速开始

前置：Node ≥ 20、pnpm 10、Claude Code CLI（`claude`）或 Gemini CLI（`gemini`）在 `PATH` 中。

```bash
pnpm install
```

### 启动 agent

```bash
# Claude Code（默认）
pnpm --filter cowork-agent dev

# Gemini CLI
pnpm --filter cowork-agent dev -- --gemini

# 指定模型
pnpm --filter cowork-agent dev -- --gemini -m gemini-2.5-pro
```

终端会打印 QR（文本二维码）和 JSON payload。

### 启动 webapp

另起一个终端：

```bash
pnpm --filter cowork-webapp dev
# 打开 http://localhost:5173
```

首页粘贴 agent 终端输出的 JSON payload（或扫描 QR），点击连接即可。30 天内同一浏览器自动重连。

## 环境变量（agent）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `COWORK_AGENT_PORT` | `4000` | WebSocket 监听端口 |
| `COWORK_AGENT_BIND` | `127.0.0.1` | 绑定网卡。改成 `0.0.0.0` 让 LAN 其他设备可连 |
| `COWORK_AGENT_ENDPOINT` | `ws://localhost:4000` | 写进 QR 的连接地址（webapp 连的就是这个） |
| `COWORK_AGENT_HOME` | `~/.cowork-agent` | 密钥与日志目录（密钥文件权限 `0600`） |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | 传给 `gemini` CLI，可选 |

安全默认：**只绑 `127.0.0.1`**。需要手机 / 平板跨设备连接时才 `export COWORK_AGENT_BIND=0.0.0.0` 并手动设置 `COWORK_AGENT_ENDPOINT=ws://<你的LAN-IP>:4000`。

## 开发

```bash
# 类型检查两个包
pnpm --filter cowork-agent --filter cowork-webapp run typecheck

# 跑全部测试（vitest）
pnpm --filter cowork-agent --filter cowork-webapp run test

# 生产构建
pnpm --filter cowork-agent build
pnpm --filter cowork-webapp build
```

GitHub Actions：
- [`pack-agent.yml`](.github/workflows/pack-agent.yml)：PR / push 时 typecheck + test + build + 打 tarball
- [`deploy-cloudflare-pages.yml`](.github/workflows/deploy-cloudflare-pages.yml)：`main` 分支变更时部署 webapp 到 Cloudflare Pages

## 协议文档

- [docs/protocol.md](docs/protocol.md) — 协议总览：握手、重连、QR payload、心跳、RPC、Delta Sync、认证
- [docs/messages.md](docs/messages.md) — 每条消息的字段语义、校验规则、JSON 示例

## License

MIT，见 [LICENSE](LICENSE)。

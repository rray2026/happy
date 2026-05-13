# Cowork

在浏览器里使用本机跑的 **Claude Code** 或 **Gemini CLI**。一次 QR 扫码完成配对，之后点对点 WebSocket 直连，你的对话和文件内容 **不经云端中转**。

同一套 webapp 同时支持桌面端和手机端；在手机上也能连回家里那台开发机的 CLI。

Fork 自 [happy-coder/happy](https://github.com/happy-coder/happy)（MIT），精简为"直连场景专用"。

## 它怎么工作

| 组件 | 运行位置 | 作用 |
|---|---|---|
| [`cowork-agent`](packages/cowork-agent) | **你的开发机** | 本地 Node 进程，把 Claude/Gemini CLI 包进 WebSocket；启动时打印 QR |
| [`cowork-webapp`](packages/cowork-webapp) | **任意浏览器** | 桌面或手机浏览器，扫码配对后直连 agent |

配对流程：agent 生成一次性 nonce（5 分钟失效）→ 打印 QR → webapp 扫码 → agent 签发 30 天 session credential → 之后同一浏览器自动重连。

## 快速开始

前置：Node ≥ 20、pnpm 10、以及 `claude`（Claude Code）或 `gemini`（Gemini CLI）在 `PATH` 里。

### 1. 装 agent

最常见的做法：从源码构建，软链到全局命令。

```bash
git clone https://github.com/rray2026/happy.git cowork && cd cowork
pnpm install
pnpm --filter cowork-agent build

# 首次用 pnpm 全局命令需先初始化 bin 目录（做过一次就跳过）
pnpm setup && source ~/.zshrc    # bash 用户改 ~/.bashrc

cd packages/cowork-agent && pnpm link --global
cowork-agent --help               # 验证
```

也可以直接下载 CI 打好的 tarball：到 [Actions](https://github.com/rray2026/happy/actions/workflows/pack-agent.yml) 的最新成功 run 里下 `cowork-agent` artifact，然后 `npm install -g ./cowork-agent-*.tgz`。

> 更多安装与开发细节见 [docs/development.md](docs/development.md)。

### 2. 启动 agent

```bash
cowork-agent                          # Claude Code（默认）
cowork-agent --gemini                 # 换成 Gemini
cowork-agent --gemini -m gemini-2.5-pro
```

终端会打印 QR（文本二维码）和等价的 JSON payload。保持这个进程开着。

### 3. 打开 webapp

- **最简单**：直接跑本地 webapp
  ```bash
  pnpm --filter cowork-webapp dev
  # 浏览器打开 http://localhost:5173
  ```
- **自部署**：webapp 是纯静态页面，构建后（`pnpm --filter cowork-webapp build`）的 `dist/` 可以扔到任何静态托管（Cloudflare Pages、Netlify、GitHub Pages、自己的 nginx）

### 4. 配对

- 桌面浏览器：把 agent 终端里那段 JSON payload 粘贴到首页 → 点「新建连接」
- 手机：用相机 / 二维码 App 扫描终端里的 QR，打开 webapp 链接，粘贴自动带入

首次配对成功后，30 天内同一浏览器打开即自动恢复，**不用再扫码**。

## 配置：环境变量

下列环境变量在启动 `cowork-agent` 前 `export` 即可生效：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `COWORK_AGENT_PORT` | `4000` | WebSocket 监听端口 |
| `COWORK_AGENT_BIND` | `127.0.0.1` | 绑定网卡。跨设备使用改成 `0.0.0.0` |
| `COWORK_AGENT_ENDPOINT` | `ws://localhost:4000` | 写进 QR 的地址。**webapp 会连的就是这个** |
| `COWORK_AGENT_HOME` | `~/.cowork-agent` | 密钥与日志目录（私钥文件 `0600` 权限） |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | 传给 `gemini` CLI |

### 在手机 / 平板上用

默认 agent 只绑 `127.0.0.1`（安全默认，只有本机能连）。要让手机通过 WiFi 连上：

```bash
# 先查本机在 LAN 的 IP（macOS）
ipconfig getifaddr en0

export COWORK_AGENT_BIND=0.0.0.0
export COWORK_AGENT_ENDPOINT=ws://<你的LAN-IP>:4000
cowork-agent
```

webapp 可以用 Cloudflare Pages 部署的公网版本（或本机 `localhost:5173`，手机同 WiFi 改成 `<你的LAN-IP>:5173`）。

> **安全提示**：agent 所有连接都用 Ed25519 签名认证，但 LAN 内任何能访问你机器端口的人如果拿到 QR payload 就能配对。QR nonce 5 分钟自动过期，之后只有保存了 session credential 的浏览器能继续用。

## 常见问题

- **"QR code 已过期"** — nonce 只有 5 分钟窗口。重启 agent 再扫。
- **"invalid credential"** — 换了机器或清空了 `~/.cowork-agent`，旧浏览器里保存的凭证不再有效。点「忘记」重新配对，或者用 webapp 首页的「Session 迁移」从旧浏览器导出凭证 JSON 再粘贴到新浏览器。
- **手机连不上** — 检查：① agent 是否 `BIND=0.0.0.0`；② `COWORK_AGENT_ENDPOINT` 是否用了 LAN IP；③ 防火墙是否放行 4000 端口；④ 手机和电脑是否同一 WiFi。

## 更多文档

- [docs/development.md](docs/development.md) — 从源码构建、测试、CI、打包
- [docs/protocol.md](docs/protocol.md) — 协议总览：握手、重连、心跳、RPC、Delta Sync、认证
- [docs/messages.md](docs/messages.md) — 每条消息的字段、校验规则、JSON 示例

## License

MIT，见 [LICENSE](LICENSE)。

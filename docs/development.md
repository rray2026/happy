# 开发文档

本文档面向在本仓库做二次开发、修复 bug 或贡献代码的人。普通使用者请看项目根目录的 [README.md](../README.md)。

## 仓库布局

pnpm workspace，三个包：

| 路径 | 说明 |
|---|---|
| [`packages/cowork-agent`](../packages/cowork-agent) | Node WebSocket 服务，桥接本地 Claude / Gemini CLI |
| [`packages/cowork-webapp`](../packages/cowork-webapp) | React + Vite 前端，通过 QR 配对后直连 agent |
| [`packages/integration-tests`](../packages/integration-tests) | 端到端测试：真实 WebSocket + 真实 `SessionClient` |

## 环境要求

- Node ≥ 20
- pnpm 10（仓库固定 `packageManager: pnpm@10.11.0`）
- Claude Code CLI（`claude`）或 Gemini CLI（`gemini`）可选，只有运行 agent 时才需要

## 从源码启动

```bash
pnpm install

# 启动 agent（默认 Claude Code）
pnpm --filter cowork-agent dev
# 换成 Gemini：
pnpm --filter cowork-agent dev -- --gemini
# 指定模型：
pnpm --filter cowork-agent dev -- --gemini -m gemini-2.5-pro

# 另起终端启动 webapp
pnpm --filter cowork-webapp dev
# 默认 http://localhost:5173
```

## 常用命令

```bash
# 类型检查
pnpm --filter cowork-agent --filter cowork-webapp run typecheck

# 单包测试（vitest）
pnpm --filter cowork-agent test
pnpm --filter cowork-webapp test

# 端到端测试（需先 install 过）
pnpm --filter integration-tests test

# 所有包一起测
pnpm -r run test

# 生产构建
pnpm --filter cowork-agent build
pnpm --filter cowork-webapp build
```

## 把 agent 软链到全局（开发时边改边用）

`pnpm link --global` 让源码改动在全局命令里实时生效，比打包重装快。

```bash
# 首次使用 pnpm 全局安装需先初始化全局 bin 目录
#   报 ERR_PNPM_NO_GLOBAL_BIN_DIR 时才需要；做过一次就跳过
pnpm setup
source ~/.zshrc   # bash 用户改 ~/.bashrc；或新开一个终端

pnpm install
pnpm --filter cowork-agent build          # bin 优先跑 dist/；缺 dist 才回退到 tsx
cd packages/cowork-agent
pnpm link --global

# 验证
cowork-agent --help
```

源码改动后重跑 `pnpm --filter cowork-agent build` 即可生效，不必重新 link。卸载：`pnpm uninstall --global cowork-agent`。

## 打 tarball（脱离仓库分发）

```bash
pnpm --filter cowork-agent build
pnpm --filter cowork-agent pack --pack-destination /tmp/cowork-agent
# 产物：/tmp/cowork-agent/cowork-agent-1.0.0.tgz
```

CI 的 [`pack-agent.yml`](../.github/workflows/pack-agent.yml) 在每次 push 到 `main` 时会自动产出同样的 tarball 并上传为 Actions artifact，可直接下载后 `npm install -g ./cowork-agent-*.tgz` 使用。

## CI / CD

| Workflow | 触发 | 作用 |
|---|---|---|
| [`pack-agent.yml`](../.github/workflows/pack-agent.yml) | push、PR 到 `main`（agent 路径变更） | typecheck + test + build + 打 tarball，7 天 artifact |
| [`deploy-cloudflare-pages.yml`](../.github/workflows/deploy-cloudflare-pages.yml) | push 到 `main`（webapp 路径变更）或手动 | build webapp → 部署到 Cloudflare Pages |

Cloudflare 部署需要仓库 secret：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，以及变量 `CF_PAGES_PROJECT_NAME`。

## 协议与消息

跨进程通信细节参见：

- [protocol.md](./protocol.md) — 协议总览：握手、重连、QR payload、心跳、RPC、Delta Sync、认证
- [messages.md](./messages.md) — 每条消息的字段、校验规则、JSON 示例

## 上游关系

Fork 自 [happy-coder/happy](https://github.com/happy-coder/happy)（MIT），裁剪为"直连场景专用"。已移除 relay 服务器、语音、社交、收件箱等上游特性。

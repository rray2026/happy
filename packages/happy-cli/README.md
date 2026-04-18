# Happy

Code on the go — control AI coding agents from your phone, browser, or terminal.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

## Usage

### Claude Code (default)

```bash
happy
# or
happy claude
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device or browser
3. Allow real-time session control — all communication is end-to-end encrypted
4. Start new sessions directly from your phone or web while your computer is online

### More agents

```
happy codex
happy gemini
happy openclaw

# or any ACP-compatible CLI
happy acp opencode
happy acp -- custom-agent --flag
```

## Daemon

The daemon is a background service that stays running on your machine. It lets you spawn and manage coding sessions remotely — from your phone or the web app — without needing an open terminal.

```bash
happy daemon start
happy daemon stop
happy daemon status
happy daemon list
```

The daemon starts automatically when you run `happy`, so you usually don't need to manage it manually.

## Authentication

```bash
happy auth login
happy auth logout
```

Happy uses cryptographic key pairs for authentication — your private key stays on your machine. All session data is end-to-end encrypted before leaving your device.

To connect third-party agent APIs:

```bash
happy connect gemini
happy connect claude
happy connect codex
happy connect status
```

## Commands

| Command | Description |
|---------|-------------|
| `happy` | Start Claude Code session (default) |
| `happy codex` | Start Codex mode |
| `happy gemini` | Start Gemini CLI session |
| `happy openclaw` | Start OpenClaw session |
| `happy acp` | Start any ACP-compatible agent |
| `happy resume <id>` | Resume a previous session |
| `happy notify` | Send push notification to your devices |
| `happy doctor` | Diagnostics & troubleshooting |
| `happy serve` | Start a direct-connect WebSocket server (no relay) |

---

## Advanced

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HAPPY_SERVER_URL` | Custom server URL (default: `https://api.cluster-fluster.com`) |
| `HAPPY_WEBAPP_URL` | Custom web app URL (default: `https://app.happy.engineering`) |
| `HAPPY_HOME_DIR` | Custom home directory for Happy data (default: `~/.happy`) |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention |
| `HAPPY_EXPERIMENTAL` | Enable experimental features |

### Sandbox (experimental)

Happy can run agents inside an OS-level sandbox to restrict file system and network access.

```bash
happy sandbox configure
happy sandbox status
happy sandbox disable
```

### Building from source

```bash
git clone https://github.com/slopus/happy
cd happy-cli
yarn install
yarn workspace happy cli --help
```

## Direct Connect (No Server Required)

`happy serve` starts an embedded WebSocket server on your machine. The web app connects directly to your CLI — no relay server, no account needed.

```bash
happy serve           # Claude (default)
happy serve --gemini  # Gemini
```

Then open the Happy web app, go to **Settings → Account → Link New Device**, paste the JSON payload shown in the terminal, and click **Connect to CLI**.

### LAN / Localhost

Works out of the box. The QR payload uses `ws://localhost:4000` by default.

### Public Domain (via nginx/caddy)

Point a domain at your machine and set the endpoint:

```bash
HAPPY_SERVE_ENDPOINT=wss://your-domain.com/happy happy serve
```

Minimal nginx config:

```nginx
location /happy {
    proxy_pass http://localhost:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### Direct Connect Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HAPPY_SERVE_PORT` | `4000` | Local port to bind |
| `HAPPY_SERVE_ENDPOINT` | `ws://localhost:4000` | Endpoint written into the QR (what the browser connects to) |

### Reconnect

After the first scan the web app stores a signed credential (valid 30 days). Subsequent visits reconnect automatically — no re-scanning needed. The CLI keeps the last 200 messages in memory so the app catches up on reconnect.

---

## Requirements

- Node.js >= 22.0.0
- For Claude: `claude` CLI installed & logged in
- For Codex: `codex` CLI installed & logged in
- For Gemini: `npm install -g @google/gemini-cli` + `happy connect gemini`

## License

MIT

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { wireAgentToServer, type AgentType } from './assemble.js';
import { buildQRPayload, loadOrGenerateCliKeys } from './auth.js';
import { keysPath, statePath } from './config.js';
import { logger } from './logger.js';
import { displayQRCode } from './qrcode.js';
import { startWsServer } from './wsServer.js';

export type { AgentType };

export interface ServeOptions {
    agent: AgentType;
    port: number;
    host: string;
    endpoint: string;
    agentArgs: string[];
    geminiApiKey: string | undefined;
    model: string | undefined;
}

export function parseServeArgs(args: string[]): ServeOptions {
    let agent: AgentType = 'claude';
    let model: string | undefined;
    const agentArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--claude') {
            agent = 'claude';
        } else if (arg === '--gemini') {
            agent = 'gemini';
        } else if ((arg === '--model' || arg === '-m') && i + 1 < args.length) {
            model = args[++i];
        } else {
            agentArgs.push(arg);
        }
    }

    const port = parseInt(process.env.COWORK_AGENT_PORT ?? '4000', 10);
    const host = process.env.COWORK_AGENT_BIND ?? '127.0.0.1';
    const defaultEndpointHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    const endpoint = process.env.COWORK_AGENT_ENDPOINT ?? `ws://${defaultEndpointHost}:${port}`;
    const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

    return { agent, port, host, endpoint, agentArgs, geminiApiKey, model };
}

interface ServeState {
    geminiSessionId?: string;
    cwd: string;
}

function loadServeState(): ServeState | null {
    try {
        if (!existsSync(statePath)) return null;
        const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as ServeState;
        return parsed.cwd === process.cwd() ? parsed : null;
    } catch {
        return null;
    }
}

function saveServeState(state: ServeState): void {
    try {
        writeFileSync(statePath, JSON.stringify(state), 'utf8');
    } catch (err) {
        logger.debug('[serve] failed to save state:', (err as Error).message);
    }
}

export async function handleServe(opts: ServeOptions): Promise<void> {
    const isReturningSession = existsSync(keysPath);
    const cliKeys = loadOrGenerateCliKeys(keysPath);
    const { sessionId } = cliKeys;
    const qrPayload = buildQRPayload(opts.endpoint, cliKeys, sessionId);

    const serveState = loadServeState();
    if (serveState?.geminiSessionId) {
        logger.debug('[serve] found previous gemini session:', serveState.geminiSessionId);
    }

    // WebSocket server and the agent wire reference each other: wsServer needs
    // onInput/onRpc at construction, but wire needs the server handle for
    // broadcasting. Resolve by constructing the server with callbacks that
    // defer to `wire`, then assigning `wire` immediately after. Callbacks only
    // fire after a ws message arrives, so `wire` is always initialized by then.
    let wire!: ReturnType<typeof wireAgentToServer>;

    const server = startWsServer({
        port: opts.port,
        host: opts.host,
        sessionId,
        cliKeys,
        qrPayload,
        onRpc: (id, method, params) => wire.handleRpc(id, method, params),
        onInput: (text) => {
            wire.handleInput(text).catch((err: Error) =>
                logger.debug('[serve] input error:', err?.message),
            );
        },
    });

    wire = wireAgentToServer({
        agent: opts.agent,
        server,
        model: opts.model,
        agentArgs: opts.agentArgs,
        resumeSessionId: serveState?.geminiSessionId,
        geminiApiKey: opts.geminiApiKey,
        onGeminiSessionId: (id) => saveServeState({ geminiSessionId: id, cwd: process.cwd() }),
    });

    const qrJson = JSON.stringify(qrPayload);
    const modelLabel = opts.model ? `  |  Model: ${opts.model}` : '';
    const isRemoteBind = opts.host === '0.0.0.0' || opts.host === '::';
    console.log(chalk.bold('\n🚀 cowork-agent — direct connect'));
    console.log(chalk.dim(`Agent: ${opts.agent}${modelLabel}  |  Bind: ${opts.host}:${opts.port}`));
    console.log(chalk.dim(`Endpoint: ${opts.endpoint}\n`));
    if (isRemoteBind) {
        console.log(
            chalk.yellow(
                '⚠  Listening on all interfaces — anyone who scans the QR within 5 min can pair. Prefer 127.0.0.1 unless you need LAN access.',
            ),
        );
    }
    if (isReturningSession) {
        console.log(chalk.green('Previous session found — webapp will reconnect automatically.'));
        console.log(chalk.dim('\nTo connect a new device, scan:'));
        displayQRCode(qrJson);
        console.log(chalk.dim('Payload: ') + qrJson);
    } else {
        displayQRCode(qrJson);
        console.log(chalk.yellow('\nScan the QR code with the cowork-webapp to connect.'));
        console.log(chalk.dim('\nPayload: ') + qrJson);
    }
    console.log();

    if (opts.agent === 'gemini' && !opts.geminiApiKey) {
        console.log(
            chalk.yellow(
                'Note: No GEMINI_API_KEY or GOOGLE_API_KEY in env — Gemini CLI will use its own stored credentials if available.',
            ),
        );
    }

    await new Promise<void>((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
    });

    wire.dispose();
    server.close();
}

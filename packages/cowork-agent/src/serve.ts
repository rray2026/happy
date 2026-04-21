import { existsSync, readFileSync } from 'node:fs';
import chalk from 'chalk';
import { buildQRPayload, loadOrGenerateCliKeys } from './auth.js';
import { keysPath } from './config.js';
import { logger } from './logger.js';
import { displayQRCode } from './qrcode.js';
import { SessionManager, type Tool } from './sessionManager.js';
import type { WsServerHandle } from './types.js';
import { startWsServer } from './wsServer.js';

export type AgentType = Tool;

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

export async function handleServe(opts: ServeOptions): Promise<void> {
    const isReturningSession = existsSync(keysPath);
    const cliKeys = loadOrGenerateCliKeys(keysPath);
    const { sessionId } = cliKeys;
    const qrPayload = buildQRPayload(opts.endpoint, cliKeys, sessionId);

    // wsServer and SessionManager reference each other: the manager pushes
    // broadcasts through the server, while the server pulls the session list
    // and replay deltas from the manager at handshake time. Callbacks defer the
    // reference to the other side, which is always fully initialized by the
    // time any of them fires (first message must cross the ws).
    let server!: WsServerHandle;

    const manager = new SessionManager({
        cwd: process.cwd(),
        geminiApiKey: opts.geminiApiKey,
        onBroadcast: (sid, seq, payload) => server.pushMessage(sid, seq, payload),
        onSessionsChanged: (sessions) => server.pushSessionsChanged(sessions),
    });

    server = startWsServer({
        port: opts.port,
        host: opts.host,
        sessionId,
        cliKeys,
        qrPayload,
        listSessions: () => manager.list(),
        replayFrom: (sid, fromSeq) => manager.replayFrom(sid, fromSeq),
        onInput: (sid, text) => {
            manager.handleInput(sid, text).catch((err: Error) =>
                logger.debug('[serve] input error:', err?.message),
            );
        },
        onRpc: (id, method, params) => handleRpc(id, method, params, manager, server),
    });

    // Auto-create one initial session from CLI flags, so `cowork-agent --gemini`
    // still "just works" without the webapp needing to create a session first.
    try {
        manager.create({
            tool: opts.agent,
            model: opts.model,
            agentArgs: opts.agentArgs,
        });
    } catch (err) {
        logger.debug('[serve] initial session create failed:', (err as Error).message);
    }

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

    manager.dispose();
    server.close();
}

// ─── RPC routing ────────────────────────────────────────────────────────────

type RpcParams = Record<string, unknown> | undefined;

async function handleRpc(
    id: string,
    method: string,
    rawParams: unknown,
    manager: SessionManager,
    server: WsServerHandle,
): Promise<void> {
    const params = (rawParams as RpcParams) ?? undefined;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

    try {
        if (method === 'session.list') {
            server.sendRpcResponse(id, { sessions: manager.list() });
            return;
        }

        if (method === 'session.create') {
            const tool = str(params?.tool);
            if (tool !== 'claude' && tool !== 'gemini') {
                server.sendRpcResponse(id, null, 'tool must be "claude" or "gemini"');
                return;
            }
            const model = str(params?.model);
            const agentArgs = Array.isArray(params?.agentArgs)
                ? (params!.agentArgs as unknown[]).filter((x): x is string => typeof x === 'string')
                : undefined;
            const session = manager.create({ tool, model, agentArgs });
            server.sendRpcResponse(id, { session });
            return;
        }

        if (method === 'session.close') {
            const sid = str(params?.sessionId);
            if (!sid) {
                server.sendRpcResponse(id, null, 'sessionId required');
                return;
            }
            server.sendRpcResponse(id, { ok: manager.close(sid) });
            return;
        }

        if (method === 'session.abort') {
            const sid = str(params?.sessionId);
            if (!sid) {
                server.sendRpcResponse(id, null, 'sessionId required');
                return;
            }
            manager.abort(sid);
            server.sendRpcResponse(id, { ok: true });
            return;
        }

        if (method === 'session.replay') {
            const sid = str(params?.sessionId);
            if (!sid) {
                server.sendRpcResponse(id, null, 'sessionId required');
                return;
            }
            const fromSeq =
                typeof params?.fromSeq === 'number' ? (params.fromSeq as number) : -1;
            const delta = manager.replayFrom(sid, fromSeq);
            for (const entry of delta) server.pushMessage(sid, entry.seq, entry.payload);
            server.sendRpcResponse(id, { ok: true, count: delta.length });
            return;
        }

        if (method === 'session.permissionResponse') {
            const sid = str(params?.sessionId);
            const permissionId = str(params?.permissionId);
            const approved = params?.approved === true;
            if (!sid || !permissionId) {
                server.sendRpcResponse(id, null, 'sessionId and permissionId required');
                return;
            }
            manager.permissionResponse(sid, permissionId, approved);
            server.sendRpcResponse(id, { ok: true });
            return;
        }

        if (method === 'getLogs') {
            const raw = params?.lines;
            const count = typeof raw === 'number' ? raw : parseInt(String(raw ?? '200'), 10);
            try {
                const content = readFileSync(logger.getLogPath(), 'utf8');
                const allLines = content.split('\n').filter(Boolean);
                server.sendRpcResponse(id, {
                    lines: allLines.slice(-(Number.isFinite(count) ? count : 200)),
                    logPath: logger.getLogPath(),
                });
            } catch {
                server.sendRpcResponse(id, { lines: [], logPath: logger.getLogPath() });
            }
            return;
        }

        server.sendRpcResponse(id, null, `unknown method: ${method}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendRpcResponse(id, null, msg);
    }
}

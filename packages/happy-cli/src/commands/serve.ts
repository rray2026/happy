import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { displayQRCode } from '@/ui/qrcode';
import { logger } from '@/ui/logger';
import { loadOrGenerateCliKeys, buildQRPayload } from '@/server/directAuth';
import { startWsServer } from '@/server/wsServer';
import { GeminiAcpSession } from '@/gemini/geminiAcp';
import { configuration } from '@/configuration';

/** Supported agent types for `happy serve` */
type AgentType = 'claude' | 'gemini';

interface ServeOptions {
    agent: AgentType;
    port: number;
    /** Public WebSocket endpoint advertised in the QR code */
    endpoint: string;
    /** Extra args forwarded to the agent CLI (Claude only) */
    agentArgs: string[];
    /** Gemini API key (GEMINI_API_KEY env, or GOOGLE_API_KEY env) */
    geminiApiKey: string | undefined;
    /** Gemini model override (e.g. gemini-2.5-flash) */
    geminiModel: string | undefined;
}

function parseArgs(args: string[]): ServeOptions {
    let agent: AgentType = 'claude';
    let geminiModel: string | undefined;
    const agentArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--claude') {
            agent = 'claude';
        } else if (arg === '--gemini') {
            agent = 'gemini';
        } else if ((arg === '--model' || arg === '-m') && i + 1 < args.length) {
            geminiModel = args[++i];
        } else {
            agentArgs.push(arg);
        }
    }

    const port = parseInt(process.env.HAPPY_SERVE_PORT ?? '4000', 10);
    const endpoint =
        process.env.HAPPY_SERVE_ENDPOINT ??
        `ws://localhost:${port}`;
    const geminiApiKey =
        process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

    return { agent, port, endpoint, agentArgs, geminiApiKey, geminiModel };
}

interface ServeState {
    geminiSessionId?: string;
    cwd: string;
}

function loadServeState(): ServeState | null {
    const path = join(configuration.happyHomeDir, 'serve-state.json');
    try {
        if (!existsSync(path)) return null;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as ServeState;
        return parsed.cwd === process.cwd() ? parsed : null;
    } catch {
        return null;
    }
}

function saveServeState(state: ServeState): void {
    const path = join(configuration.happyHomeDir, 'serve-state.json');
    try {
        writeFileSync(path, JSON.stringify(state), 'utf8');
    } catch (err) {
        logger.debug('[serve] Failed to save serve state:', (err as Error).message);
    }
}

/**
 * Spawn the Claude CLI in streaming JSON mode and stream events back via onEvent.
 * Returns a promise that resolves when the process exits.
 */
async function runClaudeProcess(opts: {
    prompt: string;
    resumeSessionId: string | null;
    agentArgs: string[];
    onEvent: (event: unknown) => void;
    onSessionId: (id: string) => void;
    abort: AbortSignal;
}): Promise<number> {
    const { prompt, resumeSessionId, agentArgs, onEvent, onSessionId, abort } = opts;

    const cliArgs: string[] = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerouslySkipPermissions'];
    if (resumeSessionId) {
        cliArgs.push('--resume', resumeSessionId);
    }
    cliArgs.push(...agentArgs, prompt);

    logger.debug(`[serve] Spawning claude with args: ${JSON.stringify(cliArgs)}`);

    return new Promise<number>((resolve) => {
        let settled = false;
        const settle = (code: number) => {
            if (settled) return;
            settled = true;
            resolve(code);
        };

        const child = spawn('claude', cliArgs, {
            stdio: ['ignore', 'pipe', 'inherit'],
            cwd: process.cwd(),
            signal: abort,
        });

        const rl = createInterface({ input: child.stdout! });
        rl.on('line', (line) => {
            try {
                const event = JSON.parse(line);
                if (event?.session_id && typeof event.session_id === 'string') {
                    onSessionId(event.session_id);
                }
                onEvent(event);
            } catch {
                // Non-JSON output (e.g. progress spinners) — skip silently
            }
        });

        child.on('error', (err) => {
            const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
            const msg = isNotFound
                ? "Command 'claude' not found — is Claude Code installed?"
                : err.message;
            logger.debug('[serve] Claude process error:', msg);
            console.error(chalk.red(`\n[serve] ${msg}\n`));
            onEvent({ type: 'result', subtype: 'error', result: msg });
            settle(1);
        });

        child.on('close', (code) => {
            logger.debug(`[serve] claude exited with code ${code}`);
            settle(code ?? 0);
        });
    });
}

/**
 * `happy serve [--claude|--gemini] [agentArgs…]`
 *
 * Starts an embedded WebSocket server on localhost and displays a QR code.
 * The webapp scans the QR code to connect directly to this machine.
 *
 * Claude mode: spawns `claude --print --output-format stream-json --verbose`
 *              per user turn, streams JSON events to the webapp.
 *
 * Gemini mode: spawns `gemini --experimental-acp` once, keeps it alive,
 *              communicates via ACP (JSON-RPC 2.0 over stdin/stdout),
 *              converts ACP session updates to Claude-compatible events.
 */
export async function handleServeCommand(args: string[]): Promise<void> {
    const opts = parseArgs(args);

    const cliKeys = loadOrGenerateCliKeys(join(configuration.happyHomeDir, 'serve-keys.json'));
    const { sessionId } = cliKeys;
    const qrPayload = buildQRPayload(opts.endpoint, cliKeys, sessionId);

    // ── Persisted serve state (Gemini session resume) ────────────────────────
    const serveState = loadServeState();
    if (serveState?.geminiSessionId) {
        logger.debug('[serve] Found previous Gemini session:', serveState.geminiSessionId);
    }

    // ── Claude state ────────────────────────────────────────────────────────
    let claudeSessionId: string | null = null;
    let claudeRunning = false;
    const abortController = new AbortController();

    // ── Permission forwarding (Gemini → webapp) ──────────────────────────────
    const permissionPending = new Map<string, (approved: boolean) => void>();

    // ── Gemini ACP session (created lazily, kept alive) ─────────────────────
    const geminiSession = opts.agent === 'gemini'
        ? new GeminiAcpSession({
            broadcast: (e) => server.broadcast(e),
            apiKey: opts.geminiApiKey,
            resumeSessionId: serveState?.geminiSessionId,
            model: opts.geminiModel,
        })
        : null;

    // ── Input handler ────────────────────────────────────────────────────────
    async function handleInput(text: string): Promise<void> {
        if (opts.agent === 'gemini' && geminiSession) {
            // Gemini: long-lived ACP session, single concurrent prompt
            if (claudeRunning) {
                logger.debug('[serve] Ignored input — Gemini is already responding');
                return;
            }
            claudeRunning = true;
            try {
                await geminiSession.sendPrompt(text);
                const gid = geminiSession.getSessionId();
                if (gid) {
                    saveServeState({ geminiSessionId: gid, cwd: process.cwd() });
                }
                server.broadcast({ type: 'result', subtype: 'success', result: 'Done' });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.debug('[serve] Gemini error:', msg);
                server.broadcast({ type: 'result', subtype: 'error', result: msg });
            } finally {
                claudeRunning = false;
            }
            return;
        }

        // Claude: subprocess per turn
        if (claudeRunning) {
            logger.debug('[serve] Ignored input — Claude is already running');
            return;
        }
        claudeRunning = true;
        try {
            await runClaudeProcess({
                prompt: text,
                resumeSessionId: claudeSessionId,
                agentArgs: opts.agentArgs,
                onEvent: (e) => server.broadcast(e),
                onSessionId: (id) => {
                    if (!claudeSessionId) {
                        claudeSessionId = id;
                        logger.debug('[serve] Claude session ID:', id);
                    }
                },
                abort: abortController.signal,
            });
        } finally {
            claudeRunning = false;
        }
    }

    // ── WebSocket server ─────────────────────────────────────────────────────
    const server = startWsServer({
        port: opts.port,
        sessionId,
        cliKeys,
        qrPayload,
        onRpc: async (id, method, params) => {
            if (method === 'abort') {
                abortController.abort();
                geminiSession?.dispose();
                server.sendRpcResponse(id, { ok: true });
            } else if (method === 'permissionResponse') {
                const p = params as { permissionId: string; approved: boolean };
                const resolver = permissionPending.get(p.permissionId);
                if (resolver) {
                    permissionPending.delete(p.permissionId);
                    resolver(p.approved);
                }
                server.sendRpcResponse(id, { ok: true });
            } else if (method === 'replay') {
                const fromSeq = parseInt(
                    (params as Record<string, unknown>)?.fromSeq as string ?? '-1', 10
                );
                server.replayFrom(isNaN(fromSeq) ? -1 : fromSeq);
                server.sendRpcResponse(id, { ok: true });
            } else if (method === 'getLogs') {
                const lines = parseInt(
                    (params as Record<string, unknown>)?.lines as string ?? '200', 10
                );
                try {
                    const content = readFileSync(logger.getLogPath(), 'utf8');
                    const allLines = content.split('\n').filter(Boolean);
                    server.sendRpcResponse(id, {
                        lines: allLines.slice(-lines),
                        logPath: logger.getLogPath(),
                    });
                } catch {
                    server.sendRpcResponse(id, { lines: [], logPath: logger.getLogPath() });
                }
            } else {
                server.sendRpcResponse(id, null, `unknown method: ${method}`);
            }
        },
        onInput: (text) => {
            handleInput(text).catch((err) =>
                logger.debug('[serve] Input error:', err?.message)
            );
        },
    });

    // ── Display QR code ──────────────────────────────────────────────────────
    const qrJson = JSON.stringify(qrPayload);
    console.log(chalk.bold('\n🚀 Happy Direct Connect'));
    const modelLabel = opts.geminiModel ? `  |  Model: ${opts.geminiModel}` : '';
    console.log(chalk.dim(`Agent: ${opts.agent}${modelLabel}  |  Port: ${opts.port}`));
    console.log(chalk.dim(`Endpoint: ${opts.endpoint}\n`));
    displayQRCode(qrJson);
    console.log(chalk.yellow('\nScan the QR code with the Happy webapp to connect.'));
    console.log(chalk.dim('\nPayload: ') + qrJson);
    console.log(chalk.dim('Waiting for connection…\n'));

    if (opts.agent === 'gemini' && !opts.geminiApiKey) {
        console.log(chalk.yellow(
            'Note: No GEMINI_API_KEY or GOOGLE_API_KEY found in environment.\n' +
            '      Gemini CLI will use its own stored credentials if available.'
        ));
    }

    // ── Keep alive ────────────────────────────────────────────────────────────
    await new Promise<void>((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
    });

    abortController.abort();
    geminiSession?.dispose();
    server.close();
}

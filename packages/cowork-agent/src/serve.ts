import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { buildQRPayload, loadOrGenerateCliKeys } from './auth.js';
import { runClaudeProcess } from './claudeProcess.js';
import { keysPath, statePath } from './config.js';
import { GeminiAcpSession } from './geminiAcp.js';
import { logger } from './logger.js';
import { displayQRCode } from './qrcode.js';
import { startWsServer } from './wsServer.js';

export type AgentType = 'claude' | 'gemini';

export interface ServeOptions {
    agent: AgentType;
    port: number;
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
    const endpoint = process.env.COWORK_AGENT_ENDPOINT ?? `ws://localhost:${port}`;
    const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

    return { agent, port, endpoint, agentArgs, geminiApiKey, model };
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

    let claudeSessionId: string | null = null;
    let agentBusy = false;
    const abortController = new AbortController();

    const permissionPending = new Map<string, (approved: boolean) => void>();

    const geminiSession =
        opts.agent === 'gemini'
            ? new GeminiAcpSession({
                  broadcast: (e) => server.broadcast(e),
                  apiKey: opts.geminiApiKey,
                  resumeSessionId: serveState?.geminiSessionId,
                  model: opts.model,
                  onPermissionRequest: (permissionId, toolName, input) =>
                      new Promise<boolean>((resolve) => {
                          permissionPending.set(permissionId, resolve);
                          server.broadcast({
                              type: 'permission-request',
                              permissionId,
                              toolName,
                              input,
                          });
                      }),
              })
            : null;

    async function handleInput(text: string): Promise<void> {
        if (agentBusy) {
            logger.debug('[serve] ignored input — agent busy');
            return;
        }
        agentBusy = true;
        try {
            if (opts.agent === 'gemini' && geminiSession) {
                try {
                    await geminiSession.sendPrompt(text);
                    const gid = geminiSession.getSessionId();
                    if (gid) saveServeState({ geminiSessionId: gid, cwd: process.cwd() });
                    server.broadcast({ type: 'result', subtype: 'success', result: 'Done' });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.debug('[serve] gemini error:', msg);
                    server.broadcast({ type: 'result', subtype: 'error', result: msg });
                }
                return;
            }

            await runClaudeProcess({
                prompt: text,
                resumeSessionId: claudeSessionId,
                model: opts.model,
                agentArgs: opts.agentArgs,
                onEvent: (e) => server.broadcast(e),
                onSessionId: (id) => {
                    if (!claudeSessionId) {
                        claudeSessionId = id;
                        logger.debug('[serve] claude session id:', id);
                    }
                },
                abort: abortController.signal,
            });
        } finally {
            agentBusy = false;
        }
    }

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
                return;
            }
            if (method === 'permissionResponse') {
                const p = params as { permissionId: string; approved: boolean };
                const resolver = permissionPending.get(p.permissionId);
                if (resolver) {
                    permissionPending.delete(p.permissionId);
                    resolver(p.approved);
                }
                server.sendRpcResponse(id, { ok: true });
                return;
            }
            if (method === 'replay') {
                const raw = (params as Record<string, unknown> | undefined)?.fromSeq;
                const fromSeq = parseInt((raw as string) ?? '-1', 10);
                server.replayFrom(isNaN(fromSeq) ? -1 : fromSeq);
                server.sendRpcResponse(id, { ok: true });
                return;
            }
            if (method === 'getLogs') {
                const raw = (params as Record<string, unknown> | undefined)?.lines;
                const count = parseInt((raw as string) ?? '200', 10);
                try {
                    const content = readFileSync(logger.getLogPath(), 'utf8');
                    const allLines = content.split('\n').filter(Boolean);
                    server.sendRpcResponse(id, {
                        lines: allLines.slice(-count),
                        logPath: logger.getLogPath(),
                    });
                } catch {
                    server.sendRpcResponse(id, { lines: [], logPath: logger.getLogPath() });
                }
                return;
            }
            server.sendRpcResponse(id, null, `unknown method: ${method}`);
        },
        onInput: (text) => {
            handleInput(text).catch((err: Error) =>
                logger.debug('[serve] input error:', err?.message),
            );
        },
    });

    const qrJson = JSON.stringify(qrPayload);
    const modelLabel = opts.model ? `  |  Model: ${opts.model}` : '';
    console.log(chalk.bold('\n🚀 cowork-agent — direct connect'));
    console.log(chalk.dim(`Agent: ${opts.agent}${modelLabel}  |  Port: ${opts.port}`));
    console.log(chalk.dim(`Endpoint: ${opts.endpoint}\n`));
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

    abortController.abort();
    geminiSession?.dispose();
    server.close();
}

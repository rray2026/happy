import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { displayQRCode } from '@/ui/qrcode';
import { logger } from '@/ui/logger';
import { generateCliKeys, buildQRPayload } from '@/server/directAuth';
import { startWsServer } from '@/server/wsServer';

/** Supported agent types for `happy serve` */
type AgentType = 'claude' | 'gemini';

interface ServeOptions {
    agent: AgentType;
    port: number;
    /** Public WebSocket endpoint advertised in the QR code */
    endpoint: string;
    /** Extra args forwarded to the agent CLI */
    agentArgs: string[];
}

function parseArgs(args: string[]): ServeOptions {
    let agent: AgentType = 'claude';
    const agentArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--claude') {
            agent = 'claude';
        } else if (arg === '--gemini') {
            agent = 'gemini';
        } else {
            agentArgs.push(arg);
        }
    }

    const port = parseInt(process.env.HAPPY_SERVE_PORT ?? '4000', 10);
    const endpoint =
        process.env.HAPPY_SERVE_ENDPOINT ??
        `ws://localhost:${port}`;

    return { agent, port, endpoint, agentArgs };
}

/**
 * Spawn the agent CLI in streaming JSON mode.
 * Both claude and gemini support --print --output-format stream-json --verbose.
 * Each stdout line is expected to be a JSON event; non-JSON lines are ignored.
 * Returns a promise that resolves when the process exits.
 */
async function runAgentProcess(opts: {
    agent: AgentType;
    prompt: string;
    resumeSessionId: string | null;
    agentArgs: string[];
    onEvent: (event: unknown) => void;
    onSessionId: (id: string) => void;
    abort: AbortSignal;
}): Promise<number> {
    const { agent, prompt, resumeSessionId, agentArgs, onEvent, onSessionId, abort } = opts;

    const cliArgs: string[] = ['--print', '--output-format', 'stream-json', '--verbose'];
    if (resumeSessionId) {
        cliArgs.push('--resume', resumeSessionId);
    }
    cliArgs.push(...agentArgs, prompt);

    logger.debug(`[serve] Spawning ${agent} with args: ${JSON.stringify(cliArgs)}`);

    return new Promise<number>((resolve) => {
        // Guard against close firing after error has already settled
        let settled = false;
        const settle = (code: number) => {
            if (settled) return;
            settled = true;
            resolve(code);
        };

        const child = spawn(agent, cliArgs, {
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
                ? `Command '${agent}' not found — is it installed and in PATH?`
                : err.message;
            logger.debug(`[serve] Agent process error: ${msg}`);
            console.error(chalk.red(`\n[serve] ${msg}\n`));
            // Surface the error to the webapp so the user sees it
            onEvent({ type: 'result', subtype: 'error', result: msg });
            settle(1);
        });

        child.on('close', (code) => {
            logger.debug(`[serve] ${agent} exited with code ${code}`);
            settle(code ?? 0);
        });
    });
}

/**
 * `happy serve [--claude|--gemini] [agentArgs…]`
 *
 * Starts an embedded WebSocket server on localhost and displays a QR code.
 * The webapp scans the QR code to connect directly to this machine.
 * User inputs from the webapp are forwarded to the agent subprocess.
 */
export async function handleServeCommand(args: string[]): Promise<void> {
    const opts = parseArgs(args);

    const sessionId = randomUUID();
    const cliKeys = generateCliKeys();
    const qrPayload = buildQRPayload(opts.endpoint, cliKeys, sessionId);

    // Track agent state
    let agentSessionId: string | null = null;
    let agentRunning = false;
    const abortController = new AbortController();

    // Input handler: called when webapp sends text
    async function handleInput(text: string): Promise<void> {
        if (agentRunning) {
            logger.debug('[serve] Ignored input – agent already running');
            return;
        }
        agentRunning = true;

        try {
            await runAgentProcess({
                agent: opts.agent,
                prompt: text,
                resumeSessionId: agentSessionId,
                agentArgs: opts.agentArgs,
                onEvent: (event) => { server.broadcast(event); },
                onSessionId: (id) => {
                    if (!agentSessionId) {
                        agentSessionId = id;
                        logger.debug(`[serve] Agent session ID: ${id}`);
                    }
                },
                abort: abortController.signal,
            });
        } finally {
            agentRunning = false;
        }
    }

    // Start WebSocket server
    const server = startWsServer({
        port: opts.port,
        sessionId,
        cliKeys,
        qrPayload,
        onRpc: async (id, method, params) => {
            if (method === 'abort') {
                abortController.abort();
                server.sendRpcResponse(id, { ok: true });
            } else if (method === 'getLogs') {
                const lines = parseInt((params as Record<string, unknown>)?.lines as string ?? '200', 10);
                try {
                    const content = readFileSync(logger.getLogPath(), 'utf8');
                    const allLines = content.split('\n').filter(Boolean);
                    server.sendRpcResponse(id, { lines: allLines.slice(-lines), logPath: logger.getLogPath() });
                } catch {
                    server.sendRpcResponse(id, { lines: [], logPath: logger.getLogPath() });
                }
            } else {
                server.sendRpcResponse(id, null, `unknown method: ${method}`);
            }
        },
        onInput: (text) => { handleInput(text).catch((err) => logger.debug(`[serve] Input error: ${err?.message}`)); },
    });

    // Display QR code
    const qrJson = JSON.stringify(qrPayload);
    console.log(chalk.bold('\n🚀 Happy Direct Connect'));
    console.log(chalk.dim(`Agent: ${opts.agent}  |  Port: ${opts.port}`));
    console.log(chalk.dim(`Endpoint: ${opts.endpoint}\n`));
    displayQRCode(qrJson);
    console.log(chalk.yellow('\nScan the QR code with the Happy webapp to connect.'));
    console.log(chalk.dim('\nPayload: ') + qrJson);
    console.log(chalk.dim('Waiting for connection…\n'));

    // Keep process alive until SIGINT/SIGTERM
    await new Promise<void>((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
    });

    abortController.abort();
    server.close();
}

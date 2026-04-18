import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { configuration } from '@/configuration';
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

        child.on('close', (code) => resolve(code ?? 0));
        child.on('error', (err) => {
            logger.debug(`[serve] Agent process error: ${err.message}`);
            resolve(1);
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
        onRpc: async (id, method, _params) => {
            // Minimal RPC: only abort is supported for now
            if (method === 'abort') {
                abortController.abort();
                server.sendRpcResponse(id, { ok: true });
            } else {
                server.sendRpcResponse(id, null, `unknown method: ${method}`);
            }
        },
        onInput: (text) => { handleInput(text).catch((err) => logger.debug(`[serve] Input error: ${err?.message}`)); },
    });

    // Display QR code
    console.log(chalk.bold('\n🚀 Happy Direct Connect'));
    console.log(chalk.dim(`Agent: ${opts.agent}  |  Port: ${opts.port}`));
    console.log(chalk.dim(`Endpoint: ${opts.endpoint}\n`));
    displayQRCode(JSON.stringify(qrPayload));
    console.log(chalk.yellow('\nScan the QR code with the Happy webapp to connect.'));
    console.log(chalk.dim('Waiting for connection…\n'));

    // Keep process alive until SIGINT/SIGTERM
    await new Promise<void>((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
    });

    abortController.abort();
    server.close();
}

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { logger } from './logger.js';

export interface RunClaudeOptions {
    prompt: string;
    resumeSessionId: string | null;
    model: string | undefined;
    agentArgs: string[];
    onEvent: (event: unknown) => void;
    onSessionId: (id: string) => void;
    abort: AbortSignal;
}

/**
 * Spawn `claude --print --output-format stream-json` for a single user turn
 * and stream the resulting JSON events to onEvent line-by-line.
 */
export async function runClaudeProcess(opts: RunClaudeOptions): Promise<number> {
    const { prompt, resumeSessionId, model, agentArgs, onEvent, onSessionId, abort } = opts;

    const cliArgs: string[] = [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
    ];
    if (model) cliArgs.push('--model', model);
    if (resumeSessionId) cliArgs.push('--resume', resumeSessionId);
    cliArgs.push(...agentArgs, prompt);

    logger.debug('[claude] spawning:', JSON.stringify(cliArgs));

    return new Promise<number>((resolve) => {
        let settled = false;
        const settle = (code: number) => {
            if (!settled) {
                settled = true;
                resolve(code);
            }
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
                // Non-JSON output — skip.
            }
        });

        child.on('error', (err) => {
            const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
            const msg = isNotFound
                ? "Command 'claude' not found — is Claude Code installed and on PATH?"
                : err.message;
            logger.debug('[claude] process error:', msg);
            console.error(chalk.red(`\n[agent] ${msg}\n`));
            onEvent({ type: 'result', subtype: 'error', result: msg });
            settle(1);
        });

        child.on('close', (code) => {
            logger.debug(`[claude] exited code=${code}`);
            settle(code ?? 0);
        });
    });
}

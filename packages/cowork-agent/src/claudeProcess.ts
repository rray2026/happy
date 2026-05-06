import { type ChildProcess, spawn } from 'node:child_process';
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
    /**
     * Working directory for the spawned `claude` process. Defaults to
     * `process.cwd()`; SessionManager passes the session-specific cwd here
     * so per-session work dirs actually affect what Claude sees.
     */
    cwd?: string;
    /** Override the `claude` binary name/path. Defaults to `'claude'`. Intended for tests. */
    command?: string;
    /** Extra env merged onto `process.env` when spawning. Intended for tests. */
    extraEnv?: Record<string, string>;
}

/**
 * Spawn `claude --print --output-format stream-json` for a single user turn
 * and stream the resulting JSON events to onEvent line-by-line.
 */
export async function runClaudeProcess(opts: RunClaudeOptions): Promise<number> {
    const {
        prompt,
        resumeSessionId,
        model,
        agentArgs,
        onEvent,
        onSessionId,
        abort,
        cwd,
        command,
        extraEnv,
    } = opts;

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

    const bin = command ?? 'claude';
    logger.debug('[claude] spawning:', bin, JSON.stringify(cliArgs));

    return new Promise<number>((resolve) => {
        let settled = false;
        const settle = (code: number) => {
            if (!settled) {
                settled = true;
                resolve(code);
            }
        };

        const child = spawn(bin, cliArgs, {
            stdio: ['ignore', 'pipe', 'inherit'],
            cwd: cwd ?? process.cwd(),
            signal: abort,
            env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
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

        child.on('exit', () => {
            // Background subprocesses can inherit stdout and keep the pipe
            // open past exit, blocking 'close'. After exit, give readline
            // a brief window to drain, then force-close our read end.
            setTimeout(() => child.stdout?.destroy(), 100);
        });

        child.on('close', (code) => {
            logger.debug(`[claude] exited code=${code}`);
            settle(code ?? 0);
        });
    });
}

// ----------------------------------------------------------------------------
// ClaudeChannel — long-lived `claude --print --input-format stream-json` per
// session. Sends prompts via stdin, receives stream-json events via stdout,
// supports mid-flight abort via control_request. See
// docs/claude-stream-input-redesign.md for full design.
// ----------------------------------------------------------------------------

export interface ClaudeChannelOptions {
    /** Set on first spawn to resume a prior conversation; ignored on hard restart. */
    resumeSessionId: string | null;
    model: string | undefined;
    agentArgs: string[];
    cwd?: string;
    /** Forwarded every stream-json event the child emits (excluding internal control_response). */
    onEvent: (event: unknown) => void;
    /** Called when the child first emits a session_id we haven't seen yet. */
    onSessionId: (id: string) => void;
    /** Called once when the channel transitions to dead (process exit, spawn failure, etc). */
    onChannelDeath?: (reason: string) => void;
    /** Test override for the binary name. */
    command?: string;
    /** Test override for env. */
    extraEnv?: Record<string, string>;
}

interface QueuedPrompt {
    prompt: string;
    resolve: () => void;
    reject: (err: Error) => void;
}

const ABORT_ACK_TIMEOUT_MS = 2000;
const CLOSE_GRACE_MS = 5000;
const CLOSE_KILL_GRACE_MS = 2000;

export class ClaudeChannel {
    private readonly opts: ClaudeChannelOptions;
    private child: ChildProcess | null = null;
    private readonly queue: QueuedPrompt[] = [];
    private inFlight: QueuedPrompt | null = null;
    private dead = false;
    private deathReason: string | null = null;
    private pendingControlAck: ((success: boolean) => void) | null = null;
    private pendingControlTimer: NodeJS.Timeout | null = null;

    constructor(opts: ClaudeChannelOptions) {
        this.opts = opts;
        this.spawnChild();
    }

    /** True iff a prompt has been written to stdin and we're still waiting for its result. */
    isBusy(): boolean {
        return this.inFlight !== null;
    }

    /** Number of prompts queued but not yet dispatched. */
    pendingCount(): number {
        return this.queue.length;
    }

    /** Resolves once the prompt's result event arrives. Rejects if the channel dies first. */
    send(prompt: string): Promise<void> {
        if (this.dead) {
            return Promise.reject(new Error(`channel is dead: ${this.deathReason ?? 'unknown'}`));
        }
        return new Promise<void>((resolve, reject) => {
            this.queue.push({ prompt, resolve, reject });
            this.dispatchNext();
        });
    }

    /**
     * Cancel any queued prompts and interrupt the in-flight turn (if any).
     * Resolves once the interrupt is acknowledged by the child (or the
     * fallback hard-restart path completes).
     */
    async abort(): Promise<void> {
        if (this.dead) return;

        // Drain queued prompts that never made it to stdin. Surface each as
        // a result/error event so the UI sees what happened.
        while (this.queue.length > 0) {
            const pending = this.queue.shift()!;
            this.opts.onEvent({
                type: 'result',
                subtype: 'error',
                result: 'aborted before dispatch',
            });
            pending.resolve();
        }

        if (!this.inFlight) return;

        // Send control_request and wait for control_response/success.
        const ackPromise = new Promise<boolean>((resolve, reject) => {
            this.pendingControlAck = resolve;
            this.pendingControlTimer = setTimeout(() => {
                if (this.pendingControlAck === resolve) {
                    this.pendingControlAck = null;
                    this.pendingControlTimer = null;
                    reject(new Error('control_response timeout'));
                }
            }, ABORT_ACK_TIMEOUT_MS);
        });

        try {
            this.writeStdin({
                type: 'control_request',
                request: { subtype: 'interrupt' },
            });
            await ackPromise;
            // result/error_during_execution arrives async via handleLine,
            // which clears inFlight and dispatches the next queued prompt.
        } catch (err) {
            // control_response never came. Force-kill the child and let
            // the death handler reject the in-flight prompt + notify owner.
            logger.debug(`[claude-channel] abort ack failed: ${(err as Error).message}, killing child`);
            this.markDead('abort timeout, child killed');
            this.child?.kill('SIGKILL');
        }
    }

    /**
     * Graceful shutdown: close stdin, give the child time to exit on its own,
     * then SIGTERM, then SIGKILL. Always resolves.
     */
    async close(): Promise<void> {
        if (this.dead || !this.child) {
            this.markDead('closed');
            return;
        }
        try {
            this.child.stdin?.end();
        } catch {
            // ignore
        }
        await new Promise<void>((resolve) => {
            const cleanup = () => {
                this.child?.off('close', onClose);
                resolve();
            };
            const onClose = () => cleanup();
            this.child!.once('close', onClose);

            const termTimer = setTimeout(() => {
                try {
                    this.child?.kill('SIGTERM');
                } catch {
                    // ignore
                }
                const killTimer = setTimeout(() => {
                    try {
                        this.child?.kill('SIGKILL');
                    } catch {
                        // ignore
                    }
                    cleanup();
                }, CLOSE_KILL_GRACE_MS);
                this.child!.once('close', () => clearTimeout(killTimer));
            }, CLOSE_GRACE_MS);

            this.child!.once('close', () => clearTimeout(termTimer));
        });
        this.markDead('closed');
    }

    // ----- internals -----

    private spawnChild(): void {
        const cliArgs: string[] = [
            '--print',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--dangerously-skip-permissions',
        ];
        if (this.opts.model) cliArgs.push('--model', this.opts.model);
        if (this.opts.resumeSessionId) cliArgs.push('--resume', this.opts.resumeSessionId);
        cliArgs.push(...this.opts.agentArgs);

        const bin = this.opts.command ?? 'claude';
        logger.debug('[claude-channel] spawning:', bin, JSON.stringify(cliArgs));

        const child = spawn(bin, cliArgs, {
            stdio: ['pipe', 'pipe', 'inherit'],
            cwd: this.opts.cwd ?? process.cwd(),
            env: this.opts.extraEnv
                ? { ...process.env, ...this.opts.extraEnv }
                : process.env,
        });
        this.child = child;

        const rl = createInterface({ input: child.stdout! });
        rl.on('line', (line) => this.handleLine(line));

        child.on('error', (err) => {
            const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
            const msg = isNotFound
                ? "Command 'claude' not found — is Claude Code installed and on PATH?"
                : err.message;
            logger.debug('[claude-channel] process error:', msg);
            console.error(chalk.red(`\n[agent] ${msg}\n`));
            this.opts.onEvent({ type: 'result', subtype: 'error', result: msg });
            this.markDead(msg);
        });

        // Same stdout-fd cleanup as runClaudeProcess: an inherited pipe held
        // by a backgrounded grandchild can keep 'close' from firing.
        child.on('exit', () => {
            setTimeout(() => child.stdout?.destroy(), 100);
        });

        child.on('close', (code) => {
            logger.debug(`[claude-channel] exited code=${code}`);
            this.markDead(`process exited with code ${code ?? 0}`);
        });

        child.stdin?.on('error', (err) => {
            // EPIPE etc. — child died before we wrote.
            this.markDead(`stdin: ${err.message}`);
        });
    }

    private handleLine(line: string): void {
        if (!line) return;
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(line) as Record<string, unknown>;
        } catch {
            return;
        }

        // control_response is part of our private control protocol — never
        // forwarded to the session stream.
        if (event.type === 'control_response') {
            const ack = this.pendingControlAck;
            this.pendingControlAck = null;
            if (this.pendingControlTimer) {
                clearTimeout(this.pendingControlTimer);
                this.pendingControlTimer = null;
            }
            const response = (event.response ?? {}) as Record<string, unknown>;
            ack?.(response.subtype === 'success');
            return;
        }

        const sessionId = event.session_id;
        if (typeof sessionId === 'string' && sessionId.length > 0) {
            this.opts.onSessionId(sessionId);
        }

        this.opts.onEvent(event);

        // Either result/success or result/error_during_execution marks the
        // current turn as done — same state transition either way.
        if (event.type === 'result') {
            const inFlight = this.inFlight;
            this.inFlight = null;
            inFlight?.resolve();
            this.dispatchNext();
        }
    }

    private dispatchNext(): void {
        if (this.dead || this.inFlight || this.queue.length === 0) return;
        const next = this.queue.shift()!;
        try {
            this.writeStdin({
                type: 'user',
                message: { role: 'user', content: next.prompt },
            });
            this.inFlight = next;
        } catch (err) {
            const e = err as Error;
            next.reject(e);
            this.markDead(`stdin write failed: ${e.message}`);
        }
    }

    private writeStdin(obj: unknown): void {
        const stdin = this.child?.stdin;
        if (!stdin || stdin.destroyed) {
            throw new Error('stdin not writable');
        }
        stdin.write(`${JSON.stringify(obj)}\n`);
    }

    private markDead(reason: string): void {
        if (this.dead) return;
        this.dead = true;
        this.deathReason = reason;

        const inFlight = this.inFlight;
        this.inFlight = null;
        inFlight?.reject(new Error(reason));

        while (this.queue.length > 0) {
            const pending = this.queue.shift()!;
            pending.reject(new Error(reason));
        }

        if (this.pendingControlTimer) {
            clearTimeout(this.pendingControlTimer);
            this.pendingControlTimer = null;
        }
        if (this.pendingControlAck) {
            this.pendingControlAck(false);
            this.pendingControlAck = null;
        }

        this.opts.onChannelDeath?.(reason);
    }
}

/**
 * Gemini ACP (Agent Client Protocol) bridge for happy serve.
 *
 * Spawns `gemini --experimental-acp` and communicates via JSON-RPC 2.0
 * over stdin/stdout (ndJSON). Keeps the process alive between prompts
 * so conversation context is preserved across turns.
 *
 * Protocol flow:
 *   → initialize({protocolVersion, clientInfo, capabilities})
 *   ← result: {sessionId, ...}
 *   → newSession({cwd, mcpServers: []})
 *   ← result: {sessionId}
 *   → prompt({sessionId, prompt: [{type:'text', text}]})   (per user message)
 *   ← sessionUpdate notifications (streaming chunks)
 *      update.sessionUpdate = 'agent_message_chunk' → textDelta
 *      update.sessionUpdate = 'tool_call'           → tool usage
 *   ← requestPermission (server→client, needs response — auto-approved)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

/** ms of silence after last chunk before we consider the response complete */
const IDLE_TIMEOUT_MS = 800;
/** ms to wait for initialize / newSession handshake */
const INIT_TIMEOUT_MS = 20_000;
/** ms total timeout per prompt turn */
const PROMPT_TIMEOUT_MS = 120_000;

type JsonRpcMsg = {
    jsonrpc: '2.0';
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
};

export type BroadcastFn = (event: unknown) => void;

/**
 * Convert an ACP session update into a Claude-compatible broadcast event.
 * Returns a special `{_acpChunk: true, text}` marker for text deltas that
 * the caller accumulates before emitting the final `assistant` event.
 */
function updateToEvent(update: Record<string, unknown>): unknown | null {
    const kind = update.sessionUpdate as string | undefined;

    if (kind === 'agent_message_chunk') {
        const textDelta = (update.messageChunk as { textDelta?: string } | undefined)?.textDelta;
        if (!textDelta) return null;
        return { _acpChunk: true, text: textDelta };
    }

    if (kind === 'tool_call') {
        const toolName = (update.kind as string | undefined) || 'tool';
        const toolId = (update.toolCallId as string | undefined) || randomUUID();
        const input = (update.content as Record<string, unknown> | undefined) || {};
        return {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
            },
        };
    }

    return null;
}

/**
 * Long-lived ACP session for Gemini CLI.
 * Create once, call sendPrompt() for each user turn.
 * Call dispose() on shutdown.
 */
export class GeminiAcpSession {
    private proc: ChildProcess | null = null;
    private acpSessionId: string | null = null;
    private msgId = 1;
    private pending = new Map<string, (msg: JsonRpcMsg) => void>();
    private textAccum = '';
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private idleResolve: (() => void) | null = null;
    private readonly broadcast: BroadcastFn;
    private readonly apiKey: string | undefined;

    constructor(opts: { broadcast: BroadcastFn; apiKey?: string }) {
        this.broadcast = opts.broadcast;
        this.apiKey = opts.apiKey;
    }

    // ── Public ────────────────────────────────────────────────────────────────

    /**
     * Send a user prompt and wait until Gemini finishes responding.
     * Starts and initialises the ACP process on first call.
     */
    async sendPrompt(text: string): Promise<void> {
        if (!this.proc || !this.acpSessionId) {
            await this.startAndInit();
        }
        await this.doPrompt(text);
    }

    dispose(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (this.proc) {
            this.proc.kill();
            this.proc = null;
        }
        this.acpSessionId = null;
    }

    // ── Private: process management ───────────────────────────────────────────

    private async startAndInit(): Promise<void> {
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (this.apiKey) {
            env.GEMINI_API_KEY = this.apiKey;
            env.GOOGLE_API_KEY = this.apiKey;
        }

        logger.debug('[GeminiAcp] spawning gemini --experimental-acp');

        const proc = spawn('gemini', ['--experimental-acp'], {
            cwd: process.cwd(),
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc = proc;

        proc.on('error', (err) => {
            const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
            const msg = isNotFound
                ? "Command 'gemini' not found — install it with: npm install -g @google/gemini-cli"
                : err.message;
            logger.debug('[GeminiAcp] spawn error:', msg);
            this.broadcast({ type: 'result', subtype: 'error', result: msg });
            this.proc = null;
            this.acpSessionId = null;
        });

        proc.on('exit', (code) => {
            logger.debug('[GeminiAcp] process exited, code:', code);
            this.proc = null;
            this.acpSessionId = null;
        });

        proc.stderr?.on('data', (d: Buffer) => {
            logger.debug('[GeminiAcp] stderr:', d.toString().trimEnd());
        });

        const rl = createInterface({ input: proc.stdout! });
        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                this.handleIncoming(JSON.parse(line) as JsonRpcMsg);
            } catch {
                logger.debug('[GeminiAcp] non-JSON stdout:', line.slice(0, 120));
            }
        });

        // initialize
        await this.rpc('initialize', {
            protocolVersion: '1.0',
            capabilities: {
                roots: { listChanged: false },
                sampling: {},
                tools: { listChanged: false },
                writeTextFile: false,
            },
            clientInfo: { name: 'happy-serve', version: '1.0.0' },
        });
        logger.debug('[GeminiAcp] initialized');

        // newSession
        const sessionRes = await this.rpc('newSession', {
            cwd: process.cwd(),
            mcpServers: [],
        });
        const sessionId = (sessionRes.result as Record<string, unknown> | undefined)?.sessionId;
        if (typeof sessionId !== 'string') {
            throw new Error('ACP newSession did not return a sessionId');
        }
        this.acpSessionId = sessionId;
        logger.debug('[GeminiAcp] session ready:', sessionId);
    }

    // ── Private: prompt flow ──────────────────────────────────────────────────

    private async doPrompt(text: string): Promise<void> {
        this.textAccum = '';

        const idlePromise = new Promise<void>((resolve) => {
            this.idleResolve = resolve;
        });

        const timeoutPromise = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Gemini response timed out')), PROMPT_TIMEOUT_MS)
        );

        // Send prompt (JSON-RPC; response is just an ack — we await idle for real output)
        await this.rpc('prompt', {
            sessionId: this.acpSessionId,
            prompt: [{ type: 'text', text }],
        });

        logger.debug('[GeminiAcp] prompt sent, waiting for idle…');
        await Promise.race([idlePromise, timeoutPromise]);

        // Flush any remaining accumulated text (safety net if idle fired before emit)
        this.flushAccum();
    }

    // ── Private: incoming message routing ────────────────────────────────────

    private handleIncoming(msg: JsonRpcMsg): void {
        logger.debug('[GeminiAcp] ←', msg.method ?? `(id=${msg.id})`);

        // Response to one of our RPCs
        if (msg.id !== undefined && msg.method === undefined) {
            const resolver = this.pending.get(String(msg.id));
            if (resolver) resolver(msg);
            return;
        }

        // Server→client permission request (needs synchronous JSON-RPC response)
        if (msg.id !== undefined && msg.method === 'requestPermission') {
            logger.debug('[GeminiAcp] requestPermission — auto-approving');
            this.write({ jsonrpc: '2.0', id: msg.id, result: { approved: true } });
            return;
        }

        // Notification: sessionUpdate
        if (msg.method === 'sessionUpdate') {
            const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
            if (!update) return;

            const event = updateToEvent(update);
            if (!event) return;

            const chunk = event as { _acpChunk?: boolean; text?: string };
            if (chunk._acpChunk) {
                this.textAccum += chunk.text ?? '';
                this.scheduleIdle();
            } else {
                this.broadcast(event);
            }
        }
    }

    // ── Private: idle timer ───────────────────────────────────────────────────

    private scheduleIdle(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            this.flushAccum();
            this.idleResolve?.();
            this.idleResolve = null;
        }, IDLE_TIMEOUT_MS);
    }

    private flushAccum(): void {
        const text = this.textAccum;
        this.textAccum = '';
        if (!text) return;
        this.broadcast({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text }] },
        });
    }

    // ── Private: JSON-RPC helpers ─────────────────────────────────────────────

    private rpc(method: string, params?: unknown): Promise<JsonRpcMsg> {
        const id = String(this.msgId++);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`ACP RPC timeout: ${method}`));
            }, INIT_TIMEOUT_MS);

            this.pending.set(id, (res) => {
                clearTimeout(timer);
                this.pending.delete(id);
                if (res.error) {
                    reject(new Error(`ACP ${method} error ${res.error.code}: ${res.error.message}`));
                } else {
                    resolve(res);
                }
            });

            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    private write(msg: JsonRpcMsg): void {
        if (!this.proc?.stdin) {
            logger.debug('[GeminiAcp] write skipped — no stdin');
            return;
        }
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }
}

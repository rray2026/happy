/**
 * Gemini ACP (Agent Client Protocol) bridge.
 *
 * Spawns `gemini --experimental-acp` and communicates over ndJSON JSON-RPC 2.0.
 * Keeps the process alive so conversation state is preserved across prompts.
 *
 * Session update kinds we translate:
 *   agent_message_chunk  → {type:'assistant', message:{...}, _delta:true, _streamId}
 *                           (progressive; one event per chunk)
 *   agent_thought_chunk  → {type:'thinking', thinking:text}
 *   tool_call            → (finalize current stream first, then emit tool_use)
 *   tool_call_update     → (finalize current stream first, then emit tool_result)
 *
 * End-of-prompt and tool boundaries emit a finalize event:
 *   {type:'assistant', _final:true, _streamId}
 * which carries no text — clients keyed by _streamId mark the stream done.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { logger } from './logger.js';

const INIT_TIMEOUT_MS = 20_000;
const PROMPT_TIMEOUT_MS = 300_000;

type JsonRpcMsg = {
    jsonrpc: '2.0';
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
};

export type BroadcastFn = (event: unknown) => void;
export type PermissionRequestFn = (
    permissionId: string,
    toolName: string,
    input: unknown,
) => Promise<boolean>;

export interface ProcessState {
    /** When non-null, an assistant text stream is in progress keyed by this id. */
    currentStreamId: string | null;
}

export function createInitialProcessState(): ProcessState {
    return { currentStreamId: null };
}

/**
 * Pure reducer: map one ACP session/update to the events to broadcast (in
 * order) and the next state. No I/O, no side effects — easy to unit test.
 *
 * `makeId` is injected so callers (and tests) control stream-id generation.
 */
export function processSessionUpdate(
    update: Record<string, unknown>,
    state: ProcessState,
    makeId: () => string,
): { emit: unknown[]; state: ProcessState } {
    const kind = update.sessionUpdate as string | undefined;

    if (kind === 'agent_message_chunk') {
        const text =
            (update.content as { text?: string } | undefined)?.text ??
            (update.messageChunk as { textDelta?: string } | undefined)?.textDelta;
        if (!text) return { emit: [], state };
        const streamId = state.currentStreamId ?? makeId();
        return {
            emit: [
                {
                    type: 'assistant',
                    message: { role: 'assistant', content: [{ type: 'text', text }] },
                    _delta: true,
                    _streamId: streamId,
                },
            ],
            state: { currentStreamId: streamId },
        };
    }

    if (kind === 'agent_thought_chunk') {
        const text = (update.content as { text?: string } | undefined)?.text;
        if (!text) return { emit: [], state };
        return { emit: [{ type: 'thinking', thinking: text }], state };
    }

    if (kind === 'tool_call') {
        const toolCallId = (update.toolCallId as string | undefined) ?? makeId();
        const name =
            (update.title as string | undefined) ??
            (update.kind as string | undefined) ??
            'tool';
        const emit: unknown[] = [];
        if (state.currentStreamId) {
            emit.push({ type: 'assistant', _final: true, _streamId: state.currentStreamId });
        }
        emit.push({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: toolCallId, name, input: {} }],
            },
        });
        return { emit, state: { currentStreamId: null } };
    }

    if (kind === 'tool_call_update') {
        const toolCallId = (update.toolCallId as string | undefined) ?? '';
        const status = update.status as string | undefined;
        const contentArr = update.content as
            | Array<{ type: string; content?: { text?: string } }>
            | undefined;
        const resultText =
            contentArr
                ?.filter((c) => c.type === 'content')
                .map((c) => c.content?.text ?? '')
                .join('') ?? '';
        const emit: unknown[] = [];
        if (state.currentStreamId) {
            emit.push({ type: 'assistant', _final: true, _streamId: state.currentStreamId });
        }
        emit.push({
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: resultText,
            is_error: status === 'failed',
        });
        return { emit, state: { currentStreamId: null } };
    }

    return { emit: [], state };
}

/** Finalize any in-progress assistant stream (called at prompt end). */
export function finalizeStream(state: ProcessState): { emit: unknown[]; state: ProcessState } {
    if (!state.currentStreamId) return { emit: [], state };
    return {
        emit: [{ type: 'assistant', _final: true, _streamId: state.currentStreamId }],
        state: { currentStreamId: null },
    };
}

export class GeminiAcpSession {
    private proc: ChildProcess | null = null;
    private acpSessionId: string | null = null;
    private msgId = 1;
    private pending = new Map<string, (msg: JsonRpcMsg) => void>();
    private processState: ProcessState = createInitialProcessState();
    private readonly broadcast: BroadcastFn;
    private readonly apiKey: string | undefined;
    private readonly onPermissionRequest: PermissionRequestFn | undefined;
    private readonly resumeSessionId: string | undefined;
    private readonly model: string | undefined;
    private readonly command: string;
    private readonly extraEnv: Record<string, string> | undefined;

    constructor(opts: {
        broadcast: BroadcastFn;
        apiKey?: string;
        onPermissionRequest?: PermissionRequestFn;
        resumeSessionId?: string;
        model?: string;
        /** Override the `gemini` binary name/path. Defaults to `'gemini'`. Intended for tests. */
        command?: string;
        /** Extra env merged onto `process.env` when spawning. Intended for tests. */
        extraEnv?: Record<string, string>;
    }) {
        this.broadcast = opts.broadcast;
        this.apiKey = opts.apiKey;
        this.onPermissionRequest = opts.onPermissionRequest;
        this.resumeSessionId = opts.resumeSessionId;
        this.model = opts.model;
        this.command = opts.command ?? 'gemini';
        this.extraEnv = opts.extraEnv;
    }

    async sendPrompt(text: string): Promise<void> {
        if (!this.proc || !this.acpSessionId) await this.startAndInit();
        try {
            this.processState = createInitialProcessState();
            await this.rpc('session/prompt', {
                sessionId: this.acpSessionId,
                prompt: [{ type: 'text', text }],
            });
            const finalize = finalizeStream(this.processState);
            this.processState = finalize.state;
            for (const ev of finalize.emit) this.broadcast(ev);
        } catch (err) {
            logger.debug('[gemini] prompt error, resetting session:', (err as Error).message);
            this.dispose();
            throw err;
        }
    }

    getSessionId(): string | null {
        return this.acpSessionId;
    }

    dispose(): void {
        if (this.proc) {
            this.proc.kill();
            this.proc = null;
        }
        this.acpSessionId = null;
    }

    private async startAndInit(): Promise<void> {
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (this.apiKey) {
            env.GEMINI_API_KEY = this.apiKey;
            env.GOOGLE_API_KEY = this.apiKey;
        }
        if (this.extraEnv) {
            Object.assign(env, this.extraEnv);
        }

        const spawnArgs = ['--experimental-acp', ...(this.model ? ['-m', this.model] : [])];
        logger.debug('[gemini] spawning', this.command, spawnArgs.join(' '));

        const proc = spawn(this.command, spawnArgs, {
            cwd: process.cwd(),
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc = proc;

        proc.on('error', (err) => {
            const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
            const msg = isNotFound
                ? "Command 'gemini' not found — install with: npm install -g @google/gemini-cli"
                : err.message;
            logger.debug('[gemini] spawn error:', msg);
            this.broadcast({ type: 'result', subtype: 'error', result: msg });
            this.proc = null;
            this.acpSessionId = null;
        });

        proc.on('exit', (code) => {
            logger.debug('[gemini] exited code=', code);
            this.proc = null;
            this.acpSessionId = null;
        });

        proc.stderr?.on('data', (d: Buffer) => {
            logger.debug('[gemini] stderr:', d.toString().trimEnd());
        });

        const rl = createInterface({ input: proc.stdout! });
        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                this.handleIncoming(JSON.parse(line) as JsonRpcMsg);
            } catch {
                logger.debug('[gemini] non-JSON stdout:', line.slice(0, 120));
            }
        });

        await this.rpc('initialize', {
            protocolVersion: 1,
            capabilities: {
                roots: { listChanged: false },
                sampling: {},
                tools: { listChanged: false },
                writeTextFile: false,
            },
            clientInfo: { name: 'cowork-agent', version: '1.0.0' },
        });
        logger.debug('[gemini] initialized');

        if (this.resumeSessionId) {
            try {
                const loadRes = await this.rpc('session/load', {
                    sessionId: this.resumeSessionId,
                    cwd: process.cwd(),
                    mcpServers: [],
                });
                const loadedId = (loadRes.result as Record<string, unknown> | undefined)
                    ?.sessionId;
                if (typeof loadedId === 'string') {
                    this.acpSessionId = loadedId;
                    logger.debug('[gemini] session resumed:', loadedId);
                    return;
                }
            } catch (err) {
                logger.debug(
                    '[gemini] session/load failed, falling back to session/new:',
                    (err as Error).message,
                );
            }
        }

        const sessionRes = await this.rpc('session/new', {
            cwd: process.cwd(),
            mcpServers: [],
        });
        const sessionId = (sessionRes.result as Record<string, unknown> | undefined)?.sessionId;
        if (typeof sessionId !== 'string') {
            throw new Error('ACP session/new did not return a sessionId');
        }
        this.acpSessionId = sessionId;
        logger.debug('[gemini] session ready:', sessionId);
    }

    private handleIncoming(msg: JsonRpcMsg): void {
        if (msg.id !== undefined && msg.method === undefined) {
            const resolver = this.pending.get(String(msg.id));
            if (resolver) resolver(msg);
            return;
        }

        if (msg.id !== undefined && msg.method === 'session/request_permission') {
            const params = msg.params as Record<string, unknown> | undefined;
            const toolCall = params?.toolCall as Record<string, unknown> | undefined;
            const toolName =
                (toolCall?.title as string | undefined) ??
                (toolCall?.kind as string | undefined) ??
                'unknown';
            const input = toolCall ?? {};
            const options =
                (params?.options as Array<{ optionId: string; kind: string }> | undefined) ?? [];
            const approveOptionId =
                options.find((o) => o.kind.startsWith('allow'))?.optionId ?? 'proceed_always';
            const denyOptionId =
                options.find((o) => o.kind.startsWith('reject') || o.optionId === 'cancel')
                    ?.optionId ?? 'cancel';
            const permissionId = randomUUID();
            const msgId = msg.id;
            if (this.onPermissionRequest) {
                this.onPermissionRequest(permissionId, toolName, input)
                    .then((approved) => {
                        const optionId = approved ? approveOptionId : denyOptionId;
                        this.write({ jsonrpc: '2.0', id: msgId, result: { optionId } });
                    })
                    .catch(() =>
                        this.write({ jsonrpc: '2.0', id: msgId, result: { optionId: denyOptionId } }),
                    );
            } else {
                this.write({ jsonrpc: '2.0', id: msgId, result: { optionId: approveOptionId } });
            }
            return;
        }

        if (msg.method === 'session/update') {
            const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
            if (!update) return;

            const { emit, state } = processSessionUpdate(update, this.processState, randomUUID);
            this.processState = state;
            for (const ev of emit) this.broadcast(ev);
        }
    }

    private rpc(method: string, params?: unknown): Promise<JsonRpcMsg> {
        const id = String(this.msgId++);
        const timeoutMs = method === 'session/prompt' ? PROMPT_TIMEOUT_MS : INIT_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`ACP RPC timeout: ${method}`));
            }, timeoutMs);

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
        if (!this.proc?.stdin) return;
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }
}

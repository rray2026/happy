/**
 * Gemini ACP (Agent Client Protocol) bridge for happy serve.
 *
 * Spawns `gemini --experimental-acp` and communicates via JSON-RPC 2.0
 * over stdin/stdout (ndJSON). Keeps the process alive between prompts
 * so conversation context is preserved across turns.
 *
 * Protocol flow (gemini-cli 0.38+):
 *   → initialize({protocolVersion: 1, clientInfo, capabilities})
 *   ← result: {protocolVersion, authMethods, agentInfo, agentCapabilities}
 *   → session/new({cwd, mcpServers: []})
 *   ← result: {sessionId, modes}
 *   → session/prompt({sessionId, prompt: [{type:'text', text}]})  (per user message)
 *   ← session/update notifications (streaming):
 *      update.sessionUpdate = 'agent_message_chunk'  → text delta (content.text)
 *      update.sessionUpdate = 'agent_thought_chunk'  → thinking text (content.text)
 *      update.sessionUpdate = 'tool_call'            → tool start (toolCallId, title, kind, status:'in_progress')
 *      update.sessionUpdate = 'tool_call_update'     → tool result (toolCallId, status:'completed'|'failed', content[])
 *   ← session/request_permission (server→client, forwarded to webapp)
 *      params: {sessionId, toolCall:{toolCallId,title,kind,content,locations}, options:[{optionId,name,kind}]}
 *      respond with: {optionId: 'proceed_always'|'proceed_once'|'cancel'}
 *   ← session/prompt result: {stopReason}  → turn complete
 *
 * All events are converted to Claude stream-json compatible format for the webapp.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

/** ms to wait for initialize / session/new handshake */
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
 * Called when Gemini requests permission for a tool call.
 * Receives a unique permissionId (for correlation), the tool name, and input params.
 * Must resolve to true (approve) or false (deny).
 */
export type PermissionRequestFn = (permissionId: string, toolName: string, input: unknown) => Promise<boolean>;

/**
 * Convert a Gemini ACP session/update notification into a Claude stream-json
 * compatible broadcast event.
 *
 * Returns one of:
 *   {_acpChunk: true, text}  — text delta; caller accumulates and flushes later
 *   Claude-format event      — broadcast immediately
 *   null                     — ignore (unknown / non-renderable update kind)
 */
function updateToEvent(update: Record<string, unknown>): unknown | null {
    const kind = update.sessionUpdate as string | undefined;

    // ── Text delta ────────────────────────────────────────────────────────────
    if (kind === 'agent_message_chunk') {
        // v0.38+: text lives in content.text; older versions used messageChunk.textDelta
        const text = (update.content as { text?: string } | undefined)?.text
            ?? (update.messageChunk as { textDelta?: string } | undefined)?.textDelta;
        if (!text) return null;
        return { _acpChunk: true, text };
    }

    // ── Thinking / reasoning ──────────────────────────────────────────────────
    if (kind === 'agent_thought_chunk') {
        const text = (update.content as { text?: string } | undefined)?.text;
        if (!text) return null;
        // Claude format: { type: 'thinking', thinking: string }
        return { type: 'thinking', thinking: text };
    }

    // ── Tool call start (status: 'in_progress') ───────────────────────────────
    // Gemini fires this when a tool begins executing.
    // Fields: toolCallId, title (human-readable op name), kind ('execute'|'edit'|…)
    if (kind === 'tool_call') {
        const toolCallId = (update.toolCallId as string | undefined) ?? randomUUID();
        // 'title' is the human-readable name (e.g. "ls -F", "Writing to foo.txt")
        // Fall back to 'kind' (e.g. "execute", "edit") if title is absent
        const name = (update.title as string | undefined)
            ?? (update.kind as string | undefined)
            ?? 'tool';
        // Input params are not available in the update itself (they live in the
        // permission request that preceded this event), so we pass an empty object.
        return {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: toolCallId, name, input: {} }],
            },
        };
    }

    // ── Tool call result (status: 'completed' | 'failed') ────────────────────
    // Gemini fires tool_call_update when a tool finishes (or errors).
    // We map it to Claude's tool_result format.
    if (kind === 'tool_call_update') {
        const toolCallId = (update.toolCallId as string | undefined) ?? '';
        const status = update.status as string | undefined;
        // content is an array of {type:'content', content:{type:'text', text}} objects
        const contentArr = update.content as Array<{ type: string; content?: { text?: string } }> | undefined;
        const resultText = contentArr
            ?.filter(c => c.type === 'content')
            .map(c => c.content?.text ?? '')
            .join('') ?? '';
        return {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: resultText,
            is_error: status === 'failed',
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
    private readonly broadcast: BroadcastFn;
    private readonly apiKey: string | undefined;
    private readonly onPermissionRequest: PermissionRequestFn | undefined;

    constructor(opts: { broadcast: BroadcastFn; apiKey?: string; onPermissionRequest?: PermissionRequestFn }) {
        this.broadcast = opts.broadcast;
        this.apiKey = opts.apiKey;
        this.onPermissionRequest = opts.onPermissionRequest;
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
            protocolVersion: 1,
            capabilities: {
                roots: { listChanged: false },
                sampling: {},
                tools: { listChanged: false },
                writeTextFile: false,
            },
            clientInfo: { name: 'happy-serve', version: '1.0.0' },
        });
        logger.debug('[GeminiAcp] initialized');

        // session/new
        const sessionRes = await this.rpc('session/new', {
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

        // session/prompt returns a result when the turn is complete (all updates already sent)
        await this.rpc('session/prompt', {
            sessionId: this.acpSessionId,
            prompt: [{ type: 'text', text }],
        });

        logger.debug('[GeminiAcp] prompt complete');
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

        // Server→client permission request — forward to webapp if handler provided, else auto-approve
        if (msg.id !== undefined && msg.method === 'session/request_permission') {
            const params = msg.params as Record<string, unknown> | undefined;
            const toolCall = params?.toolCall as Record<string, unknown> | undefined;
            const toolName = (toolCall?.title as string | undefined)
                ?? (toolCall?.kind as string | undefined)
                ?? 'unknown';
            const input = toolCall ?? {};
            const options = (params?.options as Array<{ optionId: string; kind: string }> | undefined) ?? [];
            const approveOptionId = options.find(o => o.kind.startsWith('allow'))?.optionId ?? 'proceed_always';
            const denyOptionId = options.find(o => o.kind.startsWith('reject') || o.optionId === 'cancel')?.optionId ?? 'cancel';
            const permissionId = randomUUID();
            const msgId = msg.id;
            if (this.onPermissionRequest) {
                logger.debug('[GeminiAcp] session/request_permission — forwarding to webapp, permissionId:', permissionId);
                this.onPermissionRequest(permissionId, toolName, input)
                    .then((approved) => this.write({ jsonrpc: '2.0', id: msgId, result: { optionId: approved ? approveOptionId : denyOptionId } }))
                    .catch(() => this.write({ jsonrpc: '2.0', id: msgId, result: { optionId: denyOptionId } }));
            } else {
                logger.debug('[GeminiAcp] session/request_permission — auto-approving (no handler)');
                this.write({ jsonrpc: '2.0', id: msgId, result: { optionId: approveOptionId } });
            }
            return;
        }

        // Notification: session/update
        if (msg.method === 'session/update') {
            const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
            if (!update) return;

            // Flush accumulated text before broadcasting a tool event so that
            // any preceding assistant text arrives before the tool card.
            const updateKind = update.sessionUpdate as string | undefined;
            if (updateKind === 'tool_call' || updateKind === 'tool_call_update') {
                this.flushAccum();
            }

            const event = updateToEvent(update);
            if (!event) return;

            const chunk = event as { _acpChunk?: boolean; text?: string };
            if (chunk._acpChunk) {
                this.textAccum += chunk.text ?? '';
            } else {
                this.broadcast(event);
            }
        }
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
        if (!this.proc?.stdin) {
            logger.debug('[GeminiAcp] write skipped — no stdin');
            return;
        }
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }
}

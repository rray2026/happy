import { randomUUID } from 'node:crypto';
import { runClaudeProcess } from './claudeProcess.js';
import { GeminiAcpSession } from './geminiAcp.js';
import { logger } from './logger.js';
import { SessionStore } from './sessionStore.js';

export type Tool = 'claude' | 'gemini';

/** Hard cap on concurrently live sessions per connection. */
export const MAX_SESSIONS = 10;

/**
 * Public metadata for a session — shipped over the wire and shown in the
 * webapp's session list.
 */
export interface SessionMeta {
    id: string;
    tool: Tool;
    model: string | undefined;
    cwd: string;
    createdAt: number;
    currentSeq: number;
}

export interface SessionManagerOptions {
    /** Working directory assigned to every session (= the agent's launch dir). */
    cwd: string;
    /** Gemini API key (forwarded to each gemini session at spawn time). */
    geminiApiKey?: string;
    /** Pushed to the transport for every event a session broadcasts. */
    onBroadcast: (sessionId: string, seq: number, payload: unknown) => void;
    /** Called whenever the session list changes (create / close). */
    onSessionsChanged?: (sessions: SessionMeta[]) => void;

    // Test overrides: fake binaries + env
    claudeCommand?: string;
    claudeExtraEnv?: Record<string, string>;
    geminiCommand?: string;
    geminiExtraEnv?: Record<string, string>;
}

interface SessionEntry {
    id: string;
    tool: Tool;
    model: string | undefined;
    cwd: string;
    createdAt: number;
    agentArgs: string[];
    store: SessionStore;
    // Agent process state
    claudeSessionId: string | null;
    geminiSession: GeminiAcpSession | null;
    agentBusy: boolean;
    abort: AbortController;
    permissionPending: Map<string, (approved: boolean) => void>;
}

export interface CreateSessionParams {
    tool: Tool;
    model?: string;
    agentArgs?: string[];
}

/**
 * Owns every live session on this connection. Each session has its own
 * SessionStore (seq space), its own CLI subprocess state, and its own
 * permission/abort plumbing. The transport (wsServer) is seq-agnostic —
 * the manager appends events and hands `(sessionId, seq, payload)` back
 * via `onBroadcast` for the transport to forward to the active client.
 */
export class SessionManager {
    private readonly sessions = new Map<string, SessionEntry>();
    private readonly opts: SessionManagerOptions;

    constructor(opts: SessionManagerOptions) {
        this.opts = opts;
    }

    list(): SessionMeta[] {
        return [...this.sessions.values()].map((s) => this.toMeta(s));
    }

    get(sessionId: string): SessionMeta | null {
        const e = this.sessions.get(sessionId);
        return e ? this.toMeta(e) : null;
    }

    create(params: CreateSessionParams): SessionMeta {
        if (this.sessions.size >= MAX_SESSIONS) {
            throw new Error(`session limit reached (max ${MAX_SESSIONS})`);
        }
        const id = randomUUID();
        const entry: SessionEntry = {
            id,
            tool: params.tool,
            model: params.model,
            cwd: this.opts.cwd,
            createdAt: Date.now(),
            agentArgs: params.agentArgs ?? [],
            store: new SessionStore(200),
            claudeSessionId: null,
            geminiSession: null,
            agentBusy: false,
            abort: new AbortController(),
            permissionPending: new Map(),
        };

        if (params.tool === 'gemini') {
            entry.geminiSession = new GeminiAcpSession({
                broadcast: (e) => this.appendAndBroadcast(id, e),
                apiKey: this.opts.geminiApiKey,
                model: params.model,
                command: this.opts.geminiCommand,
                extraEnv: this.opts.geminiExtraEnv,
                onPermissionRequest: (permissionId, toolName, input) =>
                    new Promise<boolean>((resolve) => {
                        entry.permissionPending.set(permissionId, resolve);
                        this.appendAndBroadcast(id, {
                            type: 'permission-request',
                            permissionId,
                            toolName,
                            input,
                        });
                    }),
            });
        }

        this.sessions.set(id, entry);
        logger.debug(`[sessionManager] created ${id} tool=${entry.tool}`);
        this.emitSessionsChanged();
        return this.toMeta(entry);
    }

    close(sessionId: string): boolean {
        const entry = this.sessions.get(sessionId);
        if (!entry) return false;
        entry.abort.abort();
        entry.geminiSession?.dispose();
        this.sessions.delete(sessionId);
        logger.debug(`[sessionManager] closed ${sessionId}`);
        this.emitSessionsChanged();
        return true;
    }

    async handleInput(sessionId: string, text: string): Promise<void> {
        const entry = this.sessions.get(sessionId);
        if (!entry) throw new Error(`unknown session: ${sessionId}`);

        // Record the user event in the session's stream so it gets a seq and
        // replays on reconnect, matching the Claude user-event shape.
        this.appendAndBroadcast(sessionId, {
            type: 'user',
            message: { role: 'user', content: text },
        });

        if (entry.agentBusy) {
            logger.debug(`[sessionManager] ${sessionId}: input ignored (busy)`);
            return;
        }
        entry.agentBusy = true;

        try {
            if (entry.tool === 'gemini' && entry.geminiSession) {
                try {
                    await entry.geminiSession.sendPrompt(text);
                    this.appendAndBroadcast(sessionId, {
                        type: 'result',
                        subtype: 'success',
                        result: 'Done',
                    });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.appendAndBroadcast(sessionId, {
                        type: 'result',
                        subtype: 'error',
                        result: msg,
                    });
                }
                return;
            }

            await runClaudeProcess({
                prompt: text,
                resumeSessionId: entry.claudeSessionId,
                model: entry.model,
                agentArgs: entry.agentArgs,
                onEvent: (e) => this.appendAndBroadcast(sessionId, e),
                onSessionId: (cid) => {
                    if (!entry.claudeSessionId) entry.claudeSessionId = cid;
                },
                abort: entry.abort.signal,
                command: this.opts.claudeCommand,
                extraEnv: this.opts.claudeExtraEnv,
            });
        } finally {
            entry.agentBusy = false;
        }
    }

    /** Returns the slice of events > fromSeq for replay. */
    replayFrom(sessionId: string, fromSeq: number): Array<{ seq: number; payload: unknown }> {
        const entry = this.sessions.get(sessionId);
        if (!entry) return [];
        return entry.store.getDelta(fromSeq);
    }

    abort(sessionId: string): void {
        const entry = this.sessions.get(sessionId);
        if (!entry) return;
        entry.abort.abort();
        entry.geminiSession?.dispose();
        entry.abort = new AbortController();
        // For gemini we'd need to re-spawn; caller can `close` + `create`.
    }

    permissionResponse(sessionId: string, permissionId: string, approved: boolean): void {
        const entry = this.sessions.get(sessionId);
        if (!entry) return;
        const resolver = entry.permissionPending.get(permissionId);
        if (resolver) {
            entry.permissionPending.delete(permissionId);
            resolver(approved);
        }
    }

    dispose(): void {
        for (const entry of this.sessions.values()) {
            entry.abort.abort();
            entry.geminiSession?.dispose();
        }
        this.sessions.clear();
    }

    private appendAndBroadcast(sessionId: string, payload: unknown): void {
        const entry = this.sessions.get(sessionId);
        if (!entry) return;
        const seq = entry.store.append(payload);
        this.opts.onBroadcast(sessionId, seq, payload);
    }

    private emitSessionsChanged(): void {
        this.opts.onSessionsChanged?.(this.list());
    }

    private toMeta(e: SessionEntry): SessionMeta {
        return {
            id: e.id,
            tool: e.tool,
            model: e.model,
            cwd: e.cwd,
            createdAt: e.createdAt,
            currentSeq: e.store.getCurrentSeq(),
        };
    }
}

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { runClaudeProcess } from './claudeProcess.js';
import { isInsideRoot } from './fsBrowser.js';
import { GeminiAcpSession } from './geminiAcp.js';
import { logger } from './logger.js';
import type { PersistedSession } from './sessionStorage.js';
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
    /**
     * Persistence hook: fires whenever a session's persistable shape changes
     * (create, or when a CLI reports a resume id). Implementations should
     * write the record to disk so the session can be rehydrated on next start.
     */
    onPersist?: (session: PersistedSession) => void;
    /** Persistence hook: fires when a session is closed. */
    onPersistRemove?: (sessionId: string) => void;

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
    /** Last-known Gemini ACP sessionId; mirrors geminiSession?.getSessionId()
     *  but survives process disposal so it can be persisted + resumed. */
    geminiSessionId: string | null;
    geminiSession: GeminiAcpSession | null;
    agentBusy: boolean;
    abort: AbortController;
    permissionPending: Map<string, (approved: boolean) => void>;
}

export interface CreateSessionParams {
    tool: Tool;
    model?: string;
    agentArgs?: string[];
    /**
     * Absolute path for this session's working directory. Must sit inside the
     * agent root (`opts.cwd`). Defaults to the agent root when unset. The
     * caller (serve.ts) is expected to have resolved + sandbox-checked this
     * already; SessionManager enforces the containment invariant too.
     */
    cwd?: string;
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
        const cwd = params.cwd ?? this.opts.cwd;
        if (!this.isCwdInsideRoot(cwd)) {
            throw new Error('cwd escapes agent root');
        }
        const entry = this.buildEntry({
            id: randomUUID(),
            tool: params.tool,
            model: params.model,
            cwd,
            createdAt: Date.now(),
            agentArgs: params.agentArgs ?? [],
            claudeSessionId: null,
            geminiSessionId: null,
        });
        logger.debug(
            `[sessionManager] created ${entry.id} tool=${entry.tool} cwd=${entry.cwd}`,
        );
        this.persistEntry(entry);
        this.emitSessionsChanged();
        return this.toMeta(entry);
    }

    /**
     * Restore previously persisted sessions without re-persisting them or
     * spawning their CLI subprocess. Called once on startup from the list
     * returned by `loadAllSessions`.
     *
     * Subprocess spawn is deferred until the first `handleInput`, at which
     * point Claude picks up `--resume <claudeSessionId>` and Gemini issues
     * `session/load` with the stored ACP id.
     */
    rehydrate(sessions: PersistedSession[]): void {
        for (const p of sessions) {
            if (this.sessions.has(p.id)) continue;
            if (this.sessions.size >= MAX_SESSIONS) {
                logger.debug('[sessionManager] rehydrate: hit MAX_SESSIONS, dropping', p.id);
                continue;
            }
            // Caller filtered by cwd already, but double-check: a stale file
            // could otherwise slip in and poison Claude's `--resume`. Per-
            // session cwds may be any subdirectory of the agent root, so the
            // check is containment, not equality.
            if (!this.isCwdInsideRoot(p.cwd)) continue;
            const entry = this.buildEntry(p);
            logger.debug(
                `[sessionManager] rehydrated ${entry.id} tool=${entry.tool}` +
                    (entry.claudeSessionId ? ` claude=${entry.claudeSessionId}` : '') +
                    (entry.geminiSessionId ? ` gemini=${entry.geminiSessionId}` : ''),
            );
        }
        if (sessions.length > 0) this.emitSessionsChanged();
    }

    /** Shared between `create` (new) and `rehydrate` (restored). */
    private buildEntry(p: {
        id: string;
        tool: Tool;
        model: string | undefined;
        cwd: string;
        createdAt: number;
        agentArgs: string[];
        claudeSessionId: string | null;
        geminiSessionId: string | null;
    }): SessionEntry {
        if (this.sessions.size >= MAX_SESSIONS) {
            throw new Error(`session limit reached (max ${MAX_SESSIONS})`);
        }
        const entry: SessionEntry = {
            id: p.id,
            tool: p.tool,
            model: p.model,
            cwd: p.cwd,
            createdAt: p.createdAt,
            agentArgs: p.agentArgs,
            store: new SessionStore(200),
            claudeSessionId: p.claudeSessionId,
            geminiSessionId: p.geminiSessionId,
            geminiSession: null,
            agentBusy: false,
            abort: new AbortController(),
            permissionPending: new Map(),
        };

        if (p.tool === 'gemini') {
            entry.geminiSession = new GeminiAcpSession({
                broadcast: (e) => this.appendAndBroadcast(entry.id, e),
                apiKey: this.opts.geminiApiKey,
                model: p.model,
                resumeSessionId: p.geminiSessionId ?? undefined,
                cwd: entry.cwd,
                command: this.opts.geminiCommand,
                extraEnv: this.opts.geminiExtraEnv,
                onSessionId: (acpId) => {
                    if (entry.geminiSessionId === acpId) return;
                    entry.geminiSessionId = acpId;
                    this.persistEntry(entry);
                },
                onPermissionRequest: (permissionId, toolName, input) =>
                    new Promise<boolean>((resolve) => {
                        entry.permissionPending.set(permissionId, resolve);
                        this.appendAndBroadcast(entry.id, {
                            type: 'permission-request',
                            permissionId,
                            toolName,
                            input,
                        });
                    }),
            });
        }

        this.sessions.set(entry.id, entry);
        return entry;
    }

    close(sessionId: string): boolean {
        const entry = this.sessions.get(sessionId);
        if (!entry) return false;
        entry.abort.abort();
        entry.geminiSession?.dispose();
        this.sessions.delete(sessionId);
        logger.debug(`[sessionManager] closed ${sessionId}`);
        this.opts.onPersistRemove?.(sessionId);
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
                cwd: entry.cwd,
                onEvent: (e) => this.appendAndBroadcast(sessionId, e),
                onSessionId: (cid) => {
                    // Persist on first observation only — Claude re-emits the
                    // same id on every turn, no point rewriting the file.
                    if (entry.claudeSessionId === cid) return;
                    entry.claudeSessionId = cid;
                    this.persistEntry(entry);
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

    private persistEntry(entry: SessionEntry): void {
        if (!this.opts.onPersist) return;
        this.opts.onPersist({
            id: entry.id,
            tool: entry.tool,
            model: entry.model,
            cwd: entry.cwd,
            createdAt: entry.createdAt,
            agentArgs: entry.agentArgs,
            claudeSessionId: entry.claudeSessionId,
            geminiSessionId: entry.geminiSessionId,
        });
    }

    /**
     * Containment check used by both `create` (validate incoming) and
     * `rehydrate` (validate persisted). Both paths are realpath-resolved
     * when possible so a symlinked session cwd passes/fails consistently
     * with the caller-side sandbox check in `resolveRelPath`. If a path
     * can't be realpathed (non-existent, unit-test fixture) we fall back
     * to the raw string — containment is still string-prefixed.
     */
    private isCwdInsideRoot(cwd: string): boolean {
        const safeRealpath = (p: string): string => {
            try {
                return realpathSync(p);
            } catch {
                return p;
            }
        };
        return isInsideRoot(safeRealpath(this.opts.cwd), safeRealpath(cwd));
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

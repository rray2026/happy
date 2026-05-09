import type {
    ChatSessionMeta,
    ClaudeEvent,
    DirectQRPayload,
    Item,
    ItemsHandler,
    PermissionEvent,
    PermissionHandler,
    RpcResponse,
    SessionsHandler,
    SocketStatus,
    StatusHandler,
    StoredCredentials,
} from '../types';
import { eventToItems, mergeItems, uid } from './events';
import { createBrowserStorage, type CredentialStorage } from './storage';
import { dismissToast, showToast } from '../toast/toastStore';

const EMPTY_ITEMS: Item[] = [];

export type WebSocketFactory = (url: string) => WebSocket;

export interface SessionClientOptions {
    storage?: CredentialStorage;
    createWebSocket?: WebSocketFactory;
    rpcTimeoutMs?: number;
    maxReconnectDelayMs?: number;
    initialReconnectDelayMs?: number;
    /** Force-reconnect if no inbound msg arrives in this window (default 75s). */
    staleThresholdMs?: number;
    /** How often to evaluate the stale check (default 15s). */
    staleCheckIntervalMs?: number;
    /** Test hook. Defaults to `window.location.protocol` in browser. */
    pageProtocol?: () => string;
}

const DEFAULTS = {
    rpcTimeoutMs: 30_000,
    maxReconnectDelayMs: 30_000,
    initialReconnectDelayMs: 1_000,
    /** Force-close the ws if no inbound msg arrives in this window. Server
     *  pings every 30s, so anything past ~2x is "the connection is dead but
     *  the browser hasn't told us" — typical after mobile backgrounding. */
    staleThresholdMs: 75_000,
    staleCheckIntervalMs: 15_000,
};

/**
 * Client that manages the WebSocket link to the cowork-agent.
 *
 * One SessionClient owns **one connection** but may carry events for many chat
 * sessions: each inbound event declares its own chat `sessionId`. The client:
 * - Handshakes (first-time via QR payload, resume via stored credential).
 * - Tracks `lastSeq` per chat sessionId and replays them on reconnect.
 * - Exposes the live chat-session list via `onSessionsChange`.
 * - Routes RPCs with per-request timeout and request-id.
 */
export class SessionClient {
    private ws: WebSocket | null = null;
    private statusHandlers = new Set<StatusHandler>();
    private sessionsHandlers = new Set<SessionsHandler>();
    private rpcPending = new Map<string, (res: RpcResponse) => void>();
    private currentStatus: SocketStatus = 'disconnected';
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay: number;
    private closed = false;
    private lastErrorReason: string | null = null;

    private endpoint = '';
    private qrPayload: DirectQRPayload | null = null;
    private webappPublicKey = '';
    private storedCredentials: StoredCredentials | null = null;
    private lastSeqs: Record<string, number> = {};
    private sessions: ChatSessionMeta[] = [];
    private refreshRpcCounter = 0;

    // Per-chat-session caches. Lifetime is the page session — wiped only when
    // the connection identity changes (fresh QR, or a different stored
    // credential). Same-credential reconnects keep them warm so re-mounting a
    // ChatScreen doesn't re-fetch full history every time.
    private items = new Map<string, Item[]>();
    /** Highest seq we've folded into `items` for each chat session — used to
     *  drop redundant events that arrive on replay after the live stream has
     *  already advanced past them. */
    private processedSeqs = new Map<string, number>();
    /** Sids for which we've already issued an explicit `session.replay` this
     *  page session. Idempotency latch — keeps reactive subscribers from
     *  triggering a replay each time they re-subscribe. */
    private bootstrappedSids = new Set<string>();
    private itemHandlers = new Map<string, Set<ItemsHandler>>();
    private pendingPermissions = new Map<string, PermissionEvent>();
    private permissionHandlers = new Map<string, Set<PermissionHandler>>();
    /** Fires only when a NEW permission request lands (not when one is cleared). */
    private permissionRequestedHandlers = new Set<(sessionId: string, perm: PermissionEvent) => void>();
    private replayRpcCounter = 0;
    private lastIncomingAt = 0;
    private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
    private visibilityHandler: (() => void) | null = null;

    private readonly storage: CredentialStorage;
    private readonly createWebSocket: WebSocketFactory;
    private readonly rpcTimeoutMs: number;
    private readonly maxReconnectDelayMs: number;
    private readonly initialReconnectDelayMs: number;
    private readonly staleThresholdMs: number;
    private readonly staleCheckIntervalMs: number;
    private readonly getPageProtocol: () => string;

    constructor(options: SessionClientOptions = {}) {
        this.storage = options.storage ?? createBrowserStorage();
        this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
        this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULTS.rpcTimeoutMs;
        this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULTS.maxReconnectDelayMs;
        this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? DEFAULTS.initialReconnectDelayMs;
        this.staleThresholdMs = options.staleThresholdMs ?? DEFAULTS.staleThresholdMs;
        this.staleCheckIntervalMs = options.staleCheckIntervalMs ?? DEFAULTS.staleCheckIntervalMs;
        this.reconnectDelay = this.initialReconnectDelayMs;
        this.getPageProtocol = options.pageProtocol ?? (() =>
            typeof location !== 'undefined' ? location.protocol : 'http:');
        this.installVisibilityHook();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    connectFirstTime(qrPayload: DirectQRPayload, webappPublicKey: string): void {
        this.closed = false;
        this.lastErrorReason = null;
        this.qrPayload = qrPayload;
        this.storedCredentials = null;
        this.endpoint = qrPayload.endpoint;
        this.webappPublicKey = webappPublicKey;
        this.lastSeqs = {};
        this.sessions = [];
        this.clearAllSessionData();
        this.resetDelay();
        this.open();
    }

    connectFromStored(creds: StoredCredentials): void {
        // Idempotent when we're already live on the same credential. Without
        // this short-circuit, a second call (e.g. user clicks "恢复连接" after
        // the App's auto-reconnect has already finished) wipes `this.sessions`
        // and `lastSeqs`, then `open()` no-ops because the ws still exists —
        // leaving the UI with an empty list until the agent next pushes a
        // `sessions` event.
        if (
            this.currentStatus === 'connected' &&
            this.storedCredentials?.sessionCredential === creds.sessionCredential
        ) {
            return;
        }
        // Different credential ⇒ a different agent ⇒ caches don't carry over.
        // Same credential after a drop ⇒ keep them; the welcome's incremental
        // replay will top them up.
        const sameAgent = this.storedCredentials?.sessionCredential === creds.sessionCredential;
        this.closed = false;
        this.lastErrorReason = null;
        this.storedCredentials = creds;
        this.qrPayload = null;
        this.endpoint = creds.endpoint;
        this.webappPublicKey = creds.webappPublicKey;
        this.lastSeqs = { ...creds.lastSeqs };
        this.sessions = [];
        if (!sameAgent) this.clearAllSessionData();
        this.resetDelay();
        this.open();
    }

    disconnect(): void {
        this.closed = true;
        this.clearTimer();
        this.stopStaleCheck();
        this.ws?.close();
        this.ws = null;
        this.setStatus('disconnected');
    }

    sendInput(sessionId: string, text: string): void {
        this.send({ type: 'input', sessionId, text });
    }

    rpc(id: string, method: string, params?: unknown): Promise<RpcResponse> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.rpcPending.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }, this.rpcTimeoutMs);
            this.rpcPending.set(id, (res) => {
                clearTimeout(timer);
                resolve(res);
            });
            this.send({ type: 'rpc', id, method, params });
        });
    }

    onStatusChange(handler: StatusHandler): () => void {
        this.statusHandlers.add(handler);
        handler(this.currentStatus);
        return () => { this.statusHandlers.delete(handler); };
    }

    onSessionsChange(handler: SessionsHandler): () => void {
        this.sessionsHandlers.add(handler);
        handler(this.sessions);
        return () => { this.sessionsHandlers.delete(handler); };
    }

    getStatus(): SocketStatus { return this.currentStatus; }
    getLastError(): string | null { return this.lastErrorReason; }
    getLastSeq(sessionId: string): number {
        return Object.prototype.hasOwnProperty.call(this.lastSeqs, sessionId)
            ? this.lastSeqs[sessionId]
            : -1;
    }
    getSessions(): ChatSessionMeta[] { return this.sessions; }

    // ── Per-chat-session data (items + permission) ────────────────────────────

    getItems(sessionId: string): Item[] {
        // Stable empty reference: callers (e.g. useSyncExternalStore) require
        // getSnapshot to return the same array when nothing changed.
        return this.items.get(sessionId) ?? EMPTY_ITEMS;
    }

    onItemsChange(sessionId: string, handler: ItemsHandler): () => void {
        let handlers = this.itemHandlers.get(sessionId);
        if (!handlers) {
            handlers = new Set();
            this.itemHandlers.set(sessionId, handlers);
        }
        handlers.add(handler);
        handler(this.items.get(sessionId) ?? []);
        // Lazily backfill: the welcome's incremental replay only carries
        // events past `lastSeqs[sid]`, so a freshly-mounted ChatScreen on
        // a session that already has history will see an empty list. Issue
        // a one-shot full replay here so the cache fills in.
        void this.ensureBootstrapped(sessionId);
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) this.itemHandlers.delete(sessionId);
        };
    }

    getPendingPermission(sessionId: string): PermissionEvent | null {
        return this.pendingPermissions.get(sessionId) ?? null;
    }

    onPermissionChange(sessionId: string, handler: PermissionHandler): () => void {
        let handlers = this.permissionHandlers.get(sessionId);
        if (!handlers) {
            handlers = new Set();
            this.permissionHandlers.set(sessionId, handlers);
        }
        handlers.add(handler);
        handler(this.pendingPermissions.get(sessionId) ?? null);
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) this.permissionHandlers.delete(sessionId);
        };
    }

    /** Fires whenever a fresh permission-request event lands for ANY session.
     *  Use this for global side effects (toast, badge counter) — for the
     *  active-session modal, use `onPermissionChange(sid, ...)` instead. */
    onPermissionRequested(handler: (sessionId: string, perm: PermissionEvent) => void): () => void {
        this.permissionRequestedHandlers.add(handler);
        return () => { this.permissionRequestedHandlers.delete(handler); };
    }

    /** Drop the cached pending permission for a session. Callers do this after
     *  responding (the agent doesn't echo a "request resolved" event). */
    clearPendingPermission(sessionId: string): void {
        if (!this.pendingPermissions.has(sessionId)) return;
        this.pendingPermissions.delete(sessionId);
        this.emitPermission(sessionId);
    }

    /** Append an optimistic local user message into the items cache. The
     *  authoritative echo from the agent is deduped by mergeItems' user-text
     *  rule, so the visible order remains stable. */
    appendOptimisticUser(sessionId: string, text: string): void {
        const next = mergeItems(this.items.get(sessionId) ?? [], [
            { kind: 'user', text, id: uid(), timestamp: Date.now() },
        ]);
        this.items.set(sessionId, next);
        this.emitItems(sessionId);
    }

    /**
     * Pull the authoritative session list from the agent and update the local
     * cache. Use this as a recovery path when the cached list might be out of
     * sync (e.g. after a tab regaining focus, or as a defensive fetch on the
     * list page). Resolves to the freshly-applied list. No-op (resolves to
     * the current cache) if not connected.
     */
    async refreshSessions(): Promise<ChatSessionMeta[]> {
        if (this.currentStatus !== 'connected') return this.sessions;
        const id = `list-${++this.refreshRpcCounter}`;
        const res = await this.rpc(id, 'session.list');
        if (res.error) throw new Error(res.error);
        const result = res.result as { sessions?: ChatSessionMeta[] } | undefined;
        if (Array.isArray(result?.sessions)) {
            this.sessions = result.sessions;
            this.emitSessions();
        }
        return this.sessions;
    }

    // ── Credential helpers (proxied to injected storage) ──────────────────────

    loadStoredCredentials(): StoredCredentials | null {
        return this.storage.loadCredentials();
    }

    clearCredentials(): void {
        this.storage.clearCredentials();
        this.clearAllSessionData();
    }

    /**
     * Persist externally-provided credentials (e.g. imported from another
     * browser). The caller is responsible for disconnecting any active
     * session first.
     */
    importCredentials(creds: StoredCredentials): void {
        this.storage.saveCredentials(creds);
    }

    getOrCreateWebappKey(): string {
        return this.storage.getOrCreateWebappKey();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private open(): void {
        if (this.ws) return;
        this.setStatus('connecting');
        try {
            const ws = this.createWebSocket(this.endpoint);
            this.ws = ws;

            ws.onopen = () => {
                this.resetDelay();
                if (this.qrPayload) {
                    this.send({
                        type: 'hello',
                        nonce: this.qrPayload.nonce,
                        webappPublicKey: this.webappPublicKey,
                    });
                } else if (this.storedCredentials) {
                    this.send({
                        type: 'hello',
                        sessionCredential: this.storedCredentials.sessionCredential,
                        webappPublicKey: this.webappPublicKey,
                        lastSeqs: this.lastSeqs,
                    });
                }
            };

            ws.onmessage = (event: MessageEvent) => {
                try {
                    this.handleMessage(JSON.parse(event.data as string));
                } catch (e) {
                    console.error('[SessionClient] failed to parse message', e, event.data);
                }
            };

            ws.onclose = () => {
                this.ws = null;
                this.stopStaleCheck();
                if (!this.closed) {
                    this.setStatus('disconnected');
                    this.scheduleReconnect();
                }
            };

            ws.onerror = () => {
                const isMixed = this.getPageProtocol() === 'https:' && this.endpoint.startsWith('ws://');
                this.lastErrorReason = isMixed
                    ? 'Mixed content: page is HTTPS but endpoint is ws://. Use wss:// or open over HTTP.'
                    : 'WebSocket connection failed — check that the CLI server is reachable.';
                this.setStatus('error');
                // Same key as the server-rejection branch — repeated reconnect
                // failures replace the existing toast instead of stacking.
                showToast(this.lastErrorReason, { kind: 'error', key: 'ws-error' });
            };
        } catch {
            this.ws = null;
            this.lastErrorReason = 'Could not open WebSocket connection';
            this.setStatus('error');
            if (!this.closed) this.scheduleReconnect();
        }
    }

    private handleMessage(msg: unknown): void {
        // Any inbound message — including keep-alive `ping` — counts as a
        // sign of life. Bump first, before parsing.
        this.lastIncomingAt = Date.now();
        if (!msg || typeof msg !== 'object') return;
        const m = msg as Record<string, unknown>;

        switch (m['type']) {
            case 'welcome': {
                const incomingSessions = Array.isArray(m['sessions'])
                    ? (m['sessions'] as ChatSessionMeta[])
                    : [];
                this.sessions = incomingSessions;
                if (this.qrPayload && typeof m['sessionCredential'] === 'string') {
                    const creds: StoredCredentials = {
                        endpoint: this.endpoint,
                        cliPublicKey: this.qrPayload.cliSignPublicKey,
                        sessionId: this.qrPayload.sessionId,
                        sessionCredential: m['sessionCredential'],
                        lastSeqs: { ...this.lastSeqs },
                        webappPublicKey: this.webappPublicKey,
                    };
                    this.storedCredentials = creds;
                    this.qrPayload = null;
                    this.storage.saveCredentials(creds);
                }
                this.emitSessions();
                this.setStatus('connected');
                this.startStaleCheck();
                break;
            }
            case 'sessions': {
                const incoming = Array.isArray(m['sessions'])
                    ? (m['sessions'] as ChatSessionMeta[])
                    : [];
                // GC per-session caches for sids the agent dropped (close).
                const live = new Set(incoming.map((s) => s.id));
                for (const sid of [...this.items.keys()]) {
                    if (!live.has(sid)) this.dropSessionData(sid);
                }
                this.sessions = incoming;
                this.emitSessions();
                break;
            }
            case 'message': {
                const sid = typeof m['sessionId'] === 'string' ? m['sessionId'] : '';
                const seq = typeof m['seq'] === 'number' ? m['seq'] : -1;
                if (sid && seq > (this.lastSeqs[sid] ?? -1)) {
                    this.lastSeqs[sid] = seq;
                    if (this.storedCredentials) {
                        this.storedCredentials = {
                            ...this.storedCredentials,
                            lastSeqs: { ...this.lastSeqs },
                        };
                        this.storage.saveCredentials(this.storedCredentials);
                    }
                }
                if (sid) this.processIntoCache(sid, seq, m['payload']);
                break;
            }
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'rpc-response': {
                const id = typeof m['id'] === 'string' ? m['id'] : '';
                this.rpcPending.get(id)?.({
                    result: m['result'],
                    error: typeof m['error'] === 'string' ? m['error'] : undefined,
                });
                this.rpcPending.delete(id);
                break;
            }
            case 'error':
                this.lastErrorReason = typeof m['message'] === 'string' ? m['message'] : 'Server rejected the connection';
                this.closed = true;
                this.ws?.close();
                this.setStatus('error');
                showToast(this.lastErrorReason, { kind: 'error', key: 'ws-error' });
                break;
        }
    }

    private send(msg: unknown): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private scheduleReconnect(): void {
        this.clearTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closed) this.open();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelayMs);
    }

    private clearTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private resetDelay(): void {
        this.reconnectDelay = this.initialReconnectDelayMs;
    }

    private setStatus(status: SocketStatus): void {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusHandlers.forEach(h => h(status));
            // Late bootstrap: subscribers that registered while disconnected
            // had their `ensureBootstrapped` short-circuit. Retry them now
            // that the connection is live.
            if (status === 'connected') {
                // Connection restored — clear any lingering ws-error toast.
                dismissToast('ws-error');
                for (const sid of this.itemHandlers.keys()) {
                    if (!this.bootstrappedSids.has(sid)) void this.ensureBootstrapped(sid);
                }
            }
        }
    }

    private emitSessions(): void {
        this.sessionsHandlers.forEach((h) => h(this.sessions));
    }

    private emitItems(sessionId: string): void {
        const handlers = this.itemHandlers.get(sessionId);
        if (!handlers) return;
        const items = this.items.get(sessionId) ?? [];
        handlers.forEach((h) => h(items));
    }

    private emitPermission(sessionId: string): void {
        const handlers = this.permissionHandlers.get(sessionId);
        if (!handlers) return;
        const perm = this.pendingPermissions.get(sessionId) ?? null;
        handlers.forEach((h) => h(perm));
    }

    /**
     * Fold a single inbound `message` payload into the per-session items
     * cache. Permission requests bypass the cache and surface separately.
     * Replays past `processedSeqs[sid]` are dropped.
     */
    private processIntoCache(sessionId: string, seq: number, payload: unknown): void {
        if (!payload || typeof payload !== 'object') return;
        const processed = this.processedSeqs.get(sessionId) ?? -1;
        if (seq <= processed) return;
        this.processedSeqs.set(sessionId, seq);

        if ((payload as { type?: string }).type === 'permission-request') {
            const perm = payload as PermissionEvent;
            this.pendingPermissions.set(sessionId, perm);
            this.emitPermission(sessionId);
            this.permissionRequestedHandlers.forEach((h) => h(sessionId, perm));
            return;
        }

        const newItems = eventToItems(payload as ClaudeEvent);
        if (!newItems.length) return;
        const next = mergeItems(this.items.get(sessionId) ?? [], newItems);
        this.items.set(sessionId, next);
        this.emitItems(sessionId);
    }

    /**
     * Trigger a one-shot full replay for `sessionId` so its items cache is
     * complete. Idempotent — once requested, stays latched until the cache is
     * explicitly dropped (session closed, or credential change).
     */
    private async ensureBootstrapped(sessionId: string): Promise<void> {
        if (this.bootstrappedSids.has(sessionId)) return;
        if (this.currentStatus !== 'connected') return;
        // Nothing to backfill if the session has no events yet — the live
        // stream alone will populate the cache as soon as the user types.
        const meta = this.sessions.find((s) => s.id === sessionId);
        if (meta && meta.currentSeq < 0) {
            this.bootstrappedSids.add(sessionId);
            return;
        }
        // Welcome already pumped this session's full history to us (e.g. fresh
        // page load with no persisted `lastSeqs[sid]`): cache is already in
        // sync with the agent's currentSeq, so no replay needed and no
        // flicker. Common case after a clean cold-start.
        const processed = this.processedSeqs.get(sessionId) ?? -1;
        if (meta && this.items.has(sessionId) && processed >= meta.currentSeq) {
            this.bootstrappedSids.add(sessionId);
            return;
        }
        this.bootstrappedSids.add(sessionId);
        // Partial cache (welcome only sent the delta past persisted lastSeqs):
        // wipe so the replay rebuilds without seq-dedup dropping older entries.
        this.items.delete(sessionId);
        this.processedSeqs.delete(sessionId);
        this.emitItems(sessionId);

        const id = `replay-${++this.replayRpcCounter}`;
        try {
            const res = await this.rpc(id, 'session.replay', { sessionId, fromSeq: -1 });
            if (res.error) this.bootstrappedSids.delete(sessionId);
        } catch {
            this.bootstrappedSids.delete(sessionId);
        }
    }

    private dropSessionData(sessionId: string): void {
        const hadItems = this.items.delete(sessionId);
        this.processedSeqs.delete(sessionId);
        this.bootstrappedSids.delete(sessionId);
        const hadPerm = this.pendingPermissions.delete(sessionId);
        if (hadItems) this.emitItems(sessionId);
        if (hadPerm) this.emitPermission(sessionId);
    }

    private clearAllSessionData(): void {
        const sids = new Set<string>([
            ...this.items.keys(),
            ...this.pendingPermissions.keys(),
        ]);
        this.items.clear();
        this.processedSeqs.clear();
        this.bootstrappedSids.clear();
        this.pendingPermissions.clear();
        // Notify any subscriber whose session just got wiped, so they observe
        // an empty list / no permission instead of stale state.
        for (const sid of sids) {
            this.emitItems(sid);
            this.emitPermission(sid);
        }
    }

    /**
     * Mobile browsers (especially iOS Safari) freeze WebSocket I/O when the
     * tab is backgrounded and sometimes return us to a "zombie" connection on
     * resume — `readyState` is still OPEN but no messages flow. The agent
     * pings every 30s; if we haven't seen *any* inbound traffic for well over
     * that window, force-close so the normal reconnect path runs.
     */
    private startStaleCheck(): void {
        this.stopStaleCheck();
        this.lastIncomingAt = Date.now();
        this.staleCheckTimer = setInterval(() => {
            if (this.currentStatus !== 'connected') return;
            if (Date.now() - this.lastIncomingAt > this.staleThresholdMs) {
                try {
                    this.ws?.close();
                } catch {
                    // ignore — onclose path will run anyway
                }
            }
        }, this.staleCheckIntervalMs);
    }

    private stopStaleCheck(): void {
        if (this.staleCheckTimer) {
            clearInterval(this.staleCheckTimer);
            this.staleCheckTimer = null;
        }
    }

    /**
     * On `visible`: if we're not connected, jump the reconnect queue. Mobile
     * users often expect "open the tab → it's working" without a 30s wait.
     */
    private installVisibilityHook(): void {
        if (typeof document === 'undefined') return;
        if (this.visibilityHandler) return;
        this.visibilityHandler = () => {
            if (document.visibilityState !== 'visible') return;
            if (this.closed) return;
            if (this.currentStatus === 'connected') return;
            this.clearTimer();
            this.resetDelay();
            this.open();
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);
    }
}

/** Default singleton used by the app. */
export const sessionClient = new SessionClient();

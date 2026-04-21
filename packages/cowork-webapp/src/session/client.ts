import type {
    ChatSessionMeta,
    DirectQRPayload,
    MessageHandler,
    RpcResponse,
    SessionsHandler,
    SocketStatus,
    StatusHandler,
    StoredCredentials,
} from '../types';
import { createBrowserStorage, type CredentialStorage } from './storage';

export type WebSocketFactory = (url: string) => WebSocket;

export interface SessionClientOptions {
    storage?: CredentialStorage;
    createWebSocket?: WebSocketFactory;
    rpcTimeoutMs?: number;
    maxReconnectDelayMs?: number;
    initialReconnectDelayMs?: number;
    /** Test hook. Defaults to `window.location.protocol` in browser. */
    pageProtocol?: () => string;
}

const DEFAULTS = {
    rpcTimeoutMs: 30_000,
    maxReconnectDelayMs: 30_000,
    initialReconnectDelayMs: 1_000,
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
    private messageHandlers = new Set<MessageHandler>();
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

    private readonly storage: CredentialStorage;
    private readonly createWebSocket: WebSocketFactory;
    private readonly rpcTimeoutMs: number;
    private readonly maxReconnectDelayMs: number;
    private readonly initialReconnectDelayMs: number;
    private readonly getPageProtocol: () => string;

    constructor(options: SessionClientOptions = {}) {
        this.storage = options.storage ?? createBrowserStorage();
        this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
        this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULTS.rpcTimeoutMs;
        this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULTS.maxReconnectDelayMs;
        this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? DEFAULTS.initialReconnectDelayMs;
        this.reconnectDelay = this.initialReconnectDelayMs;
        this.getPageProtocol = options.pageProtocol ?? (() =>
            typeof location !== 'undefined' ? location.protocol : 'http:');
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
        this.resetDelay();
        this.open();
    }

    connectFromStored(creds: StoredCredentials): void {
        this.closed = false;
        this.lastErrorReason = null;
        this.storedCredentials = creds;
        this.qrPayload = null;
        this.endpoint = creds.endpoint;
        this.webappPublicKey = creds.webappPublicKey;
        this.lastSeqs = { ...creds.lastSeqs };
        this.sessions = [];
        this.resetDelay();
        this.open();
    }

    disconnect(): void {
        this.closed = true;
        this.clearTimer();
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

    onMessage(handler: MessageHandler): () => void {
        this.messageHandlers.add(handler);
        return () => { this.messageHandlers.delete(handler); };
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

    // ── Credential helpers (proxied to injected storage) ──────────────────────

    loadStoredCredentials(): StoredCredentials | null {
        return this.storage.loadCredentials();
    }

    clearCredentials(): void {
        this.storage.clearCredentials();
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
            };
        } catch {
            this.ws = null;
            this.lastErrorReason = 'Could not open WebSocket connection';
            this.setStatus('error');
            if (!this.closed) this.scheduleReconnect();
        }
    }

    private handleMessage(msg: unknown): void {
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
                break;
            }
            case 'sessions': {
                this.sessions = Array.isArray(m['sessions'])
                    ? (m['sessions'] as ChatSessionMeta[])
                    : [];
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
                this.messageHandlers.forEach((h) => h(sid, m['payload'], seq));
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
        }
    }

    private emitSessions(): void {
        this.sessionsHandlers.forEach((h) => h(this.sessions));
    }
}

/** Default singleton used by the app. */
export const sessionClient = new SessionClient();

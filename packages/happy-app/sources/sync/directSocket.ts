import { DirectCredentials, TokenStorage } from '@/auth/tokenStorage';

export type DirectSocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type DirectMessageHandler = (payload: unknown, seq: number) => void;
export type DirectStatusHandler = (status: DirectSocketStatus) => void;

interface DirectQRPayload {
    type: 'direct';
    endpoint: string;
    cliSignPublicKey: string;
    sessionId: string;
    nonce: string;
    nonceExpiry: number;
}

interface RpcResponse {
    result?: unknown;
    error?: string;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const RPC_TIMEOUT_MS = 30_000;

class DirectSocket {
    private ws: WebSocket | null = null;
    private messageHandlers = new Set<DirectMessageHandler>();
    private statusHandlers = new Set<DirectStatusHandler>();
    private rpcPending = new Map<string, (res: RpcResponse) => void>();
    private currentStatus: DirectSocketStatus = 'disconnected';
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 1_000;
    private closed = false;

    private endpoint = '';
    private qrPayload: DirectQRPayload | null = null;
    private webappPublicKey = '';
    private storedCredentials: DirectCredentials | null = null;
    private lastSeq = -1;

    /** First-time connect using the payload scanned from the CLI QR code. */
    connectFirstTime(qrPayload: DirectQRPayload, webappPublicKey: string): void {
        this.closed = false;
        this.qrPayload = qrPayload;
        this.storedCredentials = null;
        this.endpoint = qrPayload.endpoint;
        this.webappPublicKey = webappPublicKey;
        this.lastSeq = -1;
        this.resetReconnectDelay();
        this.open();
    }

    /** Reconnect using credentials stored after a previous first-time connect. */
    connectFromStored(credentials: DirectCredentials): void {
        this.closed = false;
        this.storedCredentials = credentials;
        this.qrPayload = null;
        this.endpoint = credentials.endpoint;
        this.webappPublicKey = credentials.webappPublicKey;
        this.lastSeq = credentials.lastSeq;
        this.resetReconnectDelay();
        this.open();
    }

    disconnect(): void {
        this.closed = true;
        this.clearReconnectTimer();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.setStatus('disconnected');
    }

    sendInput(text: string): void {
        this.rawSend({ type: 'input', text });
    }

    rpc(id: string, method: string, params?: unknown): Promise<RpcResponse> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.rpcPending.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }, RPC_TIMEOUT_MS);
            this.rpcPending.set(id, (res) => {
                clearTimeout(timer);
                resolve(res);
            });
            this.rawSend({ type: 'rpc', id, method, params });
        });
    }

    onMessage(handler: DirectMessageHandler): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    onStatusChange(handler: DirectStatusHandler): () => void {
        this.statusHandlers.add(handler);
        handler(this.currentStatus);
        return () => this.statusHandlers.delete(handler);
    }

    getStatus(): DirectSocketStatus {
        return this.currentStatus;
    }

    // ── Private ──────────────────────────────────────────────────────────

    private open(): void {
        if (this.ws) return;
        this.setStatus('connecting');

        try {
            const ws = new WebSocket(this.endpoint);
            this.ws = ws;

            ws.onopen = () => {
                this.resetReconnectDelay();
                if (this.qrPayload) {
                    this.rawSend({
                        type: 'hello',
                        nonce: this.qrPayload.nonce,
                        webappPublicKey: this.webappPublicKey,
                    });
                } else if (this.storedCredentials) {
                    this.rawSend({
                        type: 'hello',
                        sessionCredential: this.storedCredentials.sessionCredential,
                        webappPublicKey: this.webappPublicKey,
                        lastSeq: this.lastSeq,
                    });
                }
            };

            ws.onmessage = (event) => {
                try {
                    this.handleMessage(JSON.parse(event.data as string));
                } catch {
                    // ignore malformed frames
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
                // onclose fires after onerror, so we just update status here
                this.setStatus('error');
            };
        } catch {
            this.ws = null;
            this.setStatus('error');
            if (!this.closed) {
                this.scheduleReconnect();
            }
        }
    }

    private handleMessage(msg: unknown): void {
        if (!msg || typeof msg !== 'object') return;
        const m = msg as Record<string, unknown>;

        switch (m.type) {
            case 'welcome': {
                if (this.qrPayload && typeof m.sessionCredential === 'string') {
                    const creds: DirectCredentials = {
                        endpoint: this.endpoint,
                        cliPublicKey: this.qrPayload.cliSignPublicKey,
                        sessionId: this.qrPayload.sessionId,
                        sessionCredential: m.sessionCredential,
                        lastSeq: typeof m.currentSeq === 'number' ? m.currentSeq : -1,
                        webappPublicKey: this.webappPublicKey,
                    };
                    this.storedCredentials = creds;
                    this.lastSeq = creds.lastSeq;
                    this.qrPayload = null;
                    TokenStorage.setDirectCredentials(creds);
                }
                this.setStatus('connected');
                break;
            }

            case 'message': {
                const seq = typeof m.seq === 'number' ? m.seq : -1;
                if (seq > this.lastSeq) {
                    this.lastSeq = seq;
                    if (this.storedCredentials) {
                        this.storedCredentials = { ...this.storedCredentials, lastSeq: seq };
                        TokenStorage.setDirectCredentials(this.storedCredentials);
                    }
                }
                this.messageHandlers.forEach((h) => h(m.payload, seq));
                break;
            }

            case 'ping':
                this.rawSend({ type: 'pong' });
                break;

            case 'rpc-response': {
                const id = typeof m.id === 'string' ? m.id : '';
                const resolver = this.rpcPending.get(id);
                if (resolver) {
                    this.rpcPending.delete(id);
                    resolver({
                        result: m.result,
                        error: typeof m.error === 'string' ? m.error : undefined,
                    });
                }
                break;
            }

            case 'error':
                // Server rejected our handshake — stop reconnecting
                this.closed = true;
                this.ws?.close();
                this.setStatus('error');
                break;
        }
    }

    private rawSend(msg: unknown): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closed) {
                this.open();
            }
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private resetReconnectDelay(): void {
        this.reconnectDelay = 1_000;
    }

    private setStatus(status: DirectSocketStatus): void {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusHandlers.forEach((h) => h(status));
        }
    }
}

export const directSocket = new DirectSocket();
export type { DirectQRPayload };

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

const TAG = '[DirectSocket]';

class DirectSocket {
    private ws: WebSocket | null = null;
    private messageHandlers = new Set<DirectMessageHandler>();
    private statusHandlers = new Set<DirectStatusHandler>();
    private rpcPending = new Map<string, (res: RpcResponse) => void>();
    private currentStatus: DirectSocketStatus = 'disconnected';
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 1_000;
    private closed = false;
    private lastErrorReason: string | null = null;

    private endpoint = '';
    private qrPayload: DirectQRPayload | null = null;
    private webappPublicKey = '';
    private storedCredentials: DirectCredentials | null = null;
    private lastSeq = -1;

    /** First-time connect using the payload scanned from the CLI QR code. */
    connectFirstTime(qrPayload: DirectQRPayload, webappPublicKey: string): void {
        console.log(TAG, 'connectFirstTime → endpoint:', qrPayload.endpoint,
            '| sessionId:', qrPayload.sessionId,
            '| nonceExpiry:', new Date(qrPayload.nonceExpiry).toISOString());
        this.closed = false;
        this.lastErrorReason = null;
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
        console.log(TAG, 'connectFromStored → endpoint:', credentials.endpoint,
            '| lastSeq:', credentials.lastSeq);
        this.closed = false;
        this.lastErrorReason = null;
        this.storedCredentials = credentials;
        this.qrPayload = null;
        this.endpoint = credentials.endpoint;
        this.webappPublicKey = credentials.webappPublicKey;
        this.lastSeq = credentials.lastSeq;
        this.resetReconnectDelay();
        this.open();
    }

    disconnect(): void {
        console.log(TAG, 'disconnect() called');
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
                console.error(TAG, 'RPC timeout:', method, '| id:', id);
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

    getLastErrorReason(): string | null {
        return this.lastErrorReason;
    }

    // ── Private ──────────────────────────────────────────────────────────

    private open(): void {
        if (this.ws) {
            console.log(TAG, 'open() skipped — ws already exists, readyState:', this.ws.readyState);
            return;
        }
        console.log(TAG, 'opening WebSocket →', this.endpoint);
        this.setStatus('connecting');

        try {
            const ws = new WebSocket(this.endpoint);
            this.ws = ws;

            ws.onopen = () => {
                console.log(TAG, 'ws.onopen — connection established');
                this.resetReconnectDelay();
                if (this.qrPayload) {
                    console.log(TAG, 'sending hello (first-time) nonce:', this.qrPayload.nonce.slice(0, 8) + '…');
                    this.rawSend({
                        type: 'hello',
                        nonce: this.qrPayload.nonce,
                        webappPublicKey: this.webappPublicKey,
                    });
                } else if (this.storedCredentials) {
                    console.log(TAG, 'sending hello (resume) lastSeq:', this.lastSeq);
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
                    const msg = JSON.parse(event.data as string);
                    console.log(TAG, 'ws.onmessage type:', (msg as any)?.type);
                    this.handleMessage(msg);
                } catch (e) {
                    console.error(TAG, 'ws.onmessage parse error:', e);
                }
            };

            ws.onclose = (event) => {
                console.log(TAG, 'ws.onclose — code:', event.code, '| reason:', event.reason || '(none)',
                    '| wasClean:', event.wasClean);
                this.ws = null;
                if (!this.closed) {
                    this.setStatus('disconnected');
                    this.scheduleReconnect();
                }
            };

            ws.onerror = (event) => {
                console.error(TAG, 'ws.onerror fired — endpoint was:', this.endpoint,
                    '| event:', JSON.stringify(event));
                const isMixedContent =
                    typeof window !== 'undefined' &&
                    window.location.protocol === 'https:' &&
                    this.endpoint.startsWith('ws://');
                // onclose fires after onerror, so we just update status here
                this.lastErrorReason = isMixedContent
                    ? 'Mixed content blocked: page is HTTPS but endpoint is ws://. Use wss:// or open the webapp over HTTP.'
                    : 'WebSocket connection failed — check that the CLI server is reachable and the port is open';
                this.setStatus('error');
            };
        } catch (e) {
            console.error(TAG, 'WebSocket constructor threw:', e);
            this.ws = null;
            this.lastErrorReason = 'Could not open WebSocket connection';
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
                console.log(TAG, 'received welcome — sessionCredential present:',
                    typeof m.sessionCredential === 'string', '| currentSeq:', m.currentSeq);
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
                this.lastErrorReason = typeof m.message === 'string' ? m.message : 'Server rejected the connection';
                console.error(TAG, 'server sent error frame:', this.lastErrorReason);
                // Server rejected our handshake — stop reconnecting
                this.closed = true;
                this.ws?.close();
                this.setStatus('error');
                break;

            default:
                console.log(TAG, 'unhandled message type:', m.type);
        }
    }

    private rawSend(msg: unknown): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        } else {
            console.warn(TAG, 'rawSend skipped — ws not open, readyState:',
                this.ws ? this.ws.readyState : 'null');
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer();
        console.log(TAG, 'scheduling reconnect in', this.reconnectDelay, 'ms');
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
            console.log(TAG, 'status:', this.currentStatus, '→', status);
            this.currentStatus = status;
            this.statusHandlers.forEach((h) => h(status));
        }
    }
}

export const directSocket = new DirectSocket();
export type { DirectQRPayload };

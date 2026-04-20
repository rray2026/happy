export type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type MessageHandler = (payload: unknown, seq: number) => void;
export type StatusHandler = (status: SocketStatus) => void;

export interface DirectQRPayload {
    type: 'direct';
    endpoint: string;
    cliSignPublicKey: string;
    sessionId: string;
    nonce: string;
    nonceExpiry: number;
}

export interface StoredCredentials {
    endpoint: string;
    cliPublicKey: string;
    sessionId: string;
    sessionCredential: string;
    lastSeq: number;
    webappPublicKey: string;
}

interface RpcResponse {
    result?: unknown;
    error?: string;
}

const STORAGE_KEY = 'cowork_direct_creds';
const WEBAPP_KEY_STORAGE = 'cowork_webapp_key';
const MAX_RECONNECT_DELAY = 30_000;
const RPC_TIMEOUT = 30_000;

export function getOrCreateWebappKey(): string {
    let key = localStorage.getItem(WEBAPP_KEY_STORAGE);
    if (!key) {
        key = Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        localStorage.setItem(WEBAPP_KEY_STORAGE, key);
    }
    return key;
}

export function loadStoredCredentials(): StoredCredentials | null {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as StoredCredentials; } catch { return null; }
}

function saveCredentials(creds: StoredCredentials): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function clearCredentials(): void {
    localStorage.removeItem(STORAGE_KEY);
}

class DirectSocket {
    private ws: WebSocket | null = null;
    private messageHandlers = new Set<MessageHandler>();
    private statusHandlers = new Set<StatusHandler>();
    private rpcPending = new Map<string, (res: RpcResponse) => void>();
    private currentStatus: SocketStatus = 'disconnected';
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 1_000;
    private closed = false;
    private lastErrorReason: string | null = null;

    private endpoint = '';
    private qrPayload: DirectQRPayload | null = null;
    private webappPublicKey = '';
    private storedCredentials: StoredCredentials | null = null;
    private lastSeq = -1;

    connectFirstTime(qrPayload: DirectQRPayload, webappPublicKey: string): void {
        this.closed = false;
        this.lastErrorReason = null;
        this.qrPayload = qrPayload;
        this.storedCredentials = null;
        this.endpoint = qrPayload.endpoint;
        this.webappPublicKey = webappPublicKey;
        this.lastSeq = -1;
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
        this.lastSeq = creds.lastSeq;
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

    sendInput(text: string): void {
        this.send({ type: 'input', text });
    }

    rpc(id: string, method: string, params?: unknown): Promise<RpcResponse> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.rpcPending.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }, RPC_TIMEOUT);
            this.rpcPending.set(id, (res) => {
                clearTimeout(timer);
                resolve(res);
            });
            this.send({ type: 'rpc', id, method, params });
        });
    }

    onMessage(handler: MessageHandler): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    onStatusChange(handler: StatusHandler): () => void {
        this.statusHandlers.add(handler);
        handler(this.currentStatus);
        return () => this.statusHandlers.delete(handler);
    }

    getStatus(): SocketStatus { return this.currentStatus; }
    getLastError(): string | null { return this.lastErrorReason; }

    private open(): void {
        if (this.ws) return;
        this.setStatus('connecting');
        try {
            const ws = new WebSocket(this.endpoint);
            this.ws = ws;

            ws.onopen = () => {
                this.resetDelay();
                if (this.qrPayload) {
                    this.send({ type: 'hello', nonce: this.qrPayload.nonce, webappPublicKey: this.webappPublicKey });
                } else if (this.storedCredentials) {
                    this.send({ type: 'hello', sessionCredential: this.storedCredentials.sessionCredential, webappPublicKey: this.webappPublicKey, lastSeq: this.lastSeq });
                }
            };

            ws.onmessage = (event) => {
                try { this.handleMessage(JSON.parse(event.data as string)); } catch { /* ignore */ }
            };

            ws.onclose = () => {
                this.ws = null;
                if (!this.closed) {
                    this.setStatus('disconnected');
                    this.scheduleReconnect();
                }
            };

            ws.onerror = () => {
                const isMixed = location.protocol === 'https:' && this.endpoint.startsWith('ws://');
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
                if (this.qrPayload && typeof m['sessionCredential'] === 'string') {
                    const creds: StoredCredentials = {
                        endpoint: this.endpoint,
                        cliPublicKey: this.qrPayload.cliSignPublicKey,
                        sessionId: this.qrPayload.sessionId,
                        sessionCredential: m['sessionCredential'],
                        lastSeq: typeof m['currentSeq'] === 'number' ? m['currentSeq'] : -1,
                        webappPublicKey: this.webappPublicKey,
                    };
                    this.storedCredentials = creds;
                    this.lastSeq = creds.lastSeq;
                    this.qrPayload = null;
                    saveCredentials(creds);
                }
                this.setStatus('connected');
                break;
            }
            case 'message': {
                const seq = typeof m['seq'] === 'number' ? m['seq'] : -1;
                if (seq > this.lastSeq) {
                    this.lastSeq = seq;
                    if (this.storedCredentials) {
                        this.storedCredentials = { ...this.storedCredentials, lastSeq: seq };
                        saveCredentials(this.storedCredentials);
                    }
                }
                this.messageHandlers.forEach(h => h(m['payload'], seq));
                break;
            }
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'rpc-response': {
                const id = typeof m['id'] === 'string' ? m['id'] : '';
                this.rpcPending.get(id)?.({ result: m['result'], error: typeof m['error'] === 'string' ? m['error'] : undefined });
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
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }

    private clearTimer(): void {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }

    private resetDelay(): void { this.reconnectDelay = 1_000; }

    private setStatus(status: SocketStatus): void {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusHandlers.forEach(h => h(status));
        }
    }
}

export const directSocket = new DirectSocket();

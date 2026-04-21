// ─── Keys & credential ───────────────────────────────────────────────────────

export interface CliKeys {
    signPublicKey: Uint8Array;
    signSecretKey: Uint8Array;
}

export interface DirectQRPayload {
    type: 'direct';
    endpoint: string;
    cliSignPublicKey: string;
    sessionId: string;
    nonce: string;
    nonceExpiry: number;
}

export interface SessionCredentialPayload {
    webappPublicKey: string;
    sessionId: string;
    expiry: number;
}

// ─── Agent → Webapp: Phase 1 (handshake) ────────────────────────────────────

export interface WelcomeMessage {
    type: 'welcome';
    sessionId: string;
    currentSeq: number;
    sessionCredential: string;
}

/** Always followed by ws.close(). Sent when handshake fails or when a malformed
 * message arrives in either phase. */
export interface ErrorMessage {
    type: 'error';
    message: string;
}

// ─── Agent → Webapp: Phase 2 (session) ──────────────────────────────────────

/** Agent event broadcast — the unit of the session's event stream.
 * `seq` is monotonic; delta replay on reconnect uses it. */
export interface SyncMessage {
    type: 'message';
    seq: number;
    payload: unknown;
}

export interface RpcResponseMessage {
    type: 'rpc-response';
    id: string;
    result?: unknown;
    error?: string;
}

export interface PingMessage {
    type: 'ping';
}

// ─── Unions ──────────────────────────────────────────────────────────────────

export type HandshakeOutbound = WelcomeMessage | ErrorMessage;
export type SessionOutbound = SyncMessage | RpcResponseMessage | PingMessage | ErrorMessage;
export type CliMessage = HandshakeOutbound | SessionOutbound;

// ─── Server handle ───────────────────────────────────────────────────────────

export interface WsServerHandle {
    /** The port the server is actually bound to (useful when opts.port was 0). */
    port(): number;
    /** Resolves once the server's `listening` event has fired. */
    ready(): Promise<void>;
    broadcast(payload: unknown): number;
    sendRpcResponse(id: string, result: unknown | null, error?: string): void;
    replayFrom(fromSeq: number): void;
    close(): void;
}

export type RpcHandler = (id: string, method: string, params: unknown) => Promise<void>;
export type InputHandler = (text: string) => void;

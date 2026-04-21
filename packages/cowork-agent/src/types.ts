import type { SessionMeta } from './sessionManager.js';

// ─── Keys & credential ───────────────────────────────────────────────────────

export interface CliKeys {
    signPublicKey: Uint8Array;
    signSecretKey: Uint8Array;
}

export interface DirectQRPayload {
    type: 'direct';
    endpoint: string;
    cliSignPublicKey: string;
    /** Connection identity. Distinct from the per-chat sessionId on every
     *  `input` / `message` envelope — this one identifies the whole
     *  agent-to-webapp link for auth purposes only. */
    sessionId: string;
    nonce: string;
    nonceExpiry: number;
}

export interface SessionCredentialPayload {
    webappPublicKey: string;
    /** Connection identity; see `DirectQRPayload.sessionId`. */
    sessionId: string;
    expiry: number;
}

// ─── Agent → Webapp: Phase 1 (handshake) ────────────────────────────────────

export interface WelcomeMessage {
    type: 'welcome';
    /** Connection identity; see `DirectQRPayload.sessionId`. */
    sessionId: string;
    sessionCredential: string;
    /** Snapshot of every live chat session at handshake time. The webapp uses
     *  this to render the session list and to reconcile with locally cached
     *  lastSeqs on reconnect. */
    sessions: SessionMeta[];
}

/** Always followed by ws.close(). Sent when handshake fails or when a malformed
 * message arrives in either phase. */
export interface ErrorMessage {
    type: 'error';
    message: string;
}

// ─── Agent → Webapp: Phase 2 (session) ──────────────────────────────────────

/** Agent event broadcast — the unit of a single chat session's event stream.
 * `seq` is monotonic *per sessionId*; delta replay on reconnect uses it. */
export interface SyncMessage {
    type: 'message';
    sessionId: string;
    seq: number;
    payload: unknown;
}

/** Emitted whenever the server-side session list changes (create / close), so
 *  clients can update their sidebar without an explicit poll. */
export interface SessionsChangedMessage {
    type: 'sessions';
    sessions: SessionMeta[];
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
export type SessionOutbound =
    | SyncMessage
    | SessionsChangedMessage
    | RpcResponseMessage
    | PingMessage
    | ErrorMessage;
export type CliMessage = HandshakeOutbound | SessionOutbound;

// ─── Server handle ───────────────────────────────────────────────────────────

export interface WsServerHandle {
    /** The port the server is actually bound to (useful when opts.port was 0). */
    port(): number;
    /** Resolves once the server's `listening` event has fired. */
    ready(): Promise<void>;
    /** Push one session event to the active client (if any). */
    pushMessage(sessionId: string, seq: number, payload: unknown): void;
    /** Push a session-list update to the active client (if any). */
    pushSessionsChanged(sessions: SessionMeta[]): void;
    sendRpcResponse(id: string, result: unknown | null, error?: string): void;
    close(): void;
}

export type RpcHandler = (id: string, method: string, params: unknown) => Promise<void>;
export type InputHandler = (sessionId: string, text: string) => void;

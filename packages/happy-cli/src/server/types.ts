import type { SessionEntry } from './sessionStore';

/** QR code payload scanned by the webapp to initiate direct connect */
export interface DirectQRPayload {
    type: 'direct';
    /** WebSocket endpoint exposed by this CLI machine */
    endpoint: string;
    /** Base64-encoded Ed25519 public key used to verify sessionCredential */
    cliSignPublicKey: string;
    /** Unique ID for this serve session */
    sessionId: string;
    /** Base64-encoded one-time nonce (32 bytes); expires at nonceExpiry */
    nonce: string;
    /** Unix timestamp (ms) after which the nonce is invalid */
    nonceExpiry: number;
}

/** Signed structure issued to the webapp after successful first-time auth */
export interface SessionCredentialPayload {
    /** Base64-encoded webapp public key stored in credential for future reconnects */
    webappPublicKey: string;
    sessionId: string;
    /** Unix timestamp (ms) after which the credential expires */
    expiry: number;
}

// ─── Messages: Webapp → CLI ──────────────────────────────────────────────────

/** First message sent by the webapp after connecting */
export interface HelloFirstTimeMessage {
    type: 'hello';
    /** Same nonce that was in the QR code */
    nonce: string;
    /** Base64-encoded webapp Ed25519 public key */
    webappPublicKey: string;
}

/** Reconnect message when webapp already has a sessionCredential */
export interface HelloReconnectMessage {
    type: 'hello';
    /** Credential issued during the first-time handshake */
    sessionCredential: string;
    /** Base64-encoded webapp public key (same as when credential was issued) */
    webappPublicKey: string;
    /** Last seq number the webapp received; CLI will send delta from lastSeq+1 */
    lastSeq: number;
}

export type HelloMessage = HelloFirstTimeMessage | HelloReconnectMessage;

/** User text input forwarded to the agent */
export interface InputMessage {
    type: 'input';
    text: string;
}

/** RPC call from webapp (permission approval, abort, etc.) */
export interface RpcRequestMessage {
    type: 'rpc';
    id: string;
    method: string;
    params: unknown;
}

/** Keepalive response */
export interface PongMessage {
    type: 'pong';
}

export type WebappMessage = HelloMessage | InputMessage | RpcRequestMessage | PongMessage;

// ─── Messages: CLI → Webapp ──────────────────────────────────────────────────

/** Sent immediately after successful auth (first-time or reconnect) */
export interface WelcomeMessage {
    type: 'welcome';
    sessionId: string;
    /** Highest seq number currently in the store; -1 if no messages yet */
    currentSeq: number;
    /** Signed credential to store for future reconnects */
    sessionCredential: string;
}

/** Agent output message (Claude events, tool calls, etc.) */
export interface DataMessage {
    type: 'message';
    seq: number;
    /** Raw agent event object */
    payload: unknown;
}

/** Error message sent before closing the connection */
export interface ErrorMessage {
    type: 'error';
    message: string;
}

/** Keepalive ping */
export interface PingMessage {
    type: 'ping';
}

/** Response to an RPC request */
export interface RpcResponseMessage {
    type: 'rpc-response';
    id: string;
    result?: unknown;
    error?: string;
}

export type CliMessage =
    | WelcomeMessage
    | DataMessage
    | ErrorMessage
    | PingMessage
    | RpcResponseMessage;

// ─── Server handle ───────────────────────────────────────────────────────────

export interface WsServerHandle {
    /** Append a payload to the store and push it to the connected client. Returns the assigned seq. */
    broadcast(payload: unknown): number;
    /** Send an RPC response to the connected client */
    sendRpcResponse(id: string, result: unknown | null, error?: string): void;
    /** Close the server */
    close(): void;
}

export type RpcHandler = (id: string, method: string, params: unknown) => Promise<void>;
export type InputHandler = (text: string) => void;

/** Ed25519 keypair used by the CLI for signing credentials */
export interface CliKeys {
    signPublicKey: Uint8Array;
    signSecretKey: Uint8Array;
}

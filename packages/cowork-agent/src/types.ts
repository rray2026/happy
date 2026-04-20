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

// ── Webapp → Agent ───────────────────────────────────────────────────────────

export interface HelloFirstTimeMessage {
    type: 'hello';
    nonce: string;
    webappPublicKey: string;
}

export interface HelloReconnectMessage {
    type: 'hello';
    sessionCredential: string;
    webappPublicKey: string;
    lastSeq: number;
}

export type HelloMessage = HelloFirstTimeMessage | HelloReconnectMessage;

export interface InputMessage {
    type: 'input';
    text: string;
}

export interface RpcRequestMessage {
    type: 'rpc';
    id: string;
    method: string;
    params: unknown;
}

export interface PongMessage {
    type: 'pong';
}

export type WebappMessage = HelloMessage | InputMessage | RpcRequestMessage | PongMessage;

// ── Agent → Webapp ───────────────────────────────────────────────────────────

export interface WelcomeMessage {
    type: 'welcome';
    sessionId: string;
    currentSeq: number;
    sessionCredential: string;
}

export interface DataMessage {
    type: 'message';
    seq: number;
    payload: unknown;
}

export interface ErrorMessage {
    type: 'error';
    message: string;
}

export interface PingMessage {
    type: 'ping';
}

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

// ── Server handle ────────────────────────────────────────────────────────────

export interface WsServerHandle {
    broadcast(payload: unknown): number;
    sendRpcResponse(id: string, result: unknown | null, error?: string): void;
    replayFrom(fromSeq: number): void;
    close(): void;
}

export type RpcHandler = (id: string, method: string, params: unknown) => Promise<void>;
export type InputHandler = (text: string) => void;

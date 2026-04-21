// ── Socket types ──────────────────────────────────────────────────────────────

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

export interface RpcResponse {
    result?: unknown;
    error?: string;
}

// ── Claude event types ────────────────────────────────────────────────────────

export interface TextPart { type: 'text'; text: string; }
export interface ToolUsePart { type: 'tool_use'; id: string; name: string; input: unknown; }
export interface ToolResultPart { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; }
export type ContentPart = TextPart | ToolUsePart | ToolResultPart;

export interface AssistantEvent {
    type: 'assistant';
    message?: { role: 'assistant'; content: ContentPart[] };
    /** Progressive delta marker: text in `message` is an increment, not the full message. */
    _delta?: boolean;
    /** End-of-stream marker. When true, `message` is usually absent. */
    _final?: boolean;
    /** Stable id grouping delta + final events into one stream. */
    _streamId?: string;
}
export interface UserEvent { type: 'user'; message: { role: 'user'; content: string | ContentPart[] }; }
export interface ResultEvent { type: 'result'; subtype: 'success' | 'error'; result: string; }
export interface SystemEvent { type: 'system'; subtype: string; session_id?: string; }
export interface PermissionEvent { type: 'permission-request'; permissionId: string; toolName: string; input: unknown; }

export type ClaudeEvent =
    | AssistantEvent
    | UserEvent
    | ResultEvent
    | SystemEvent
    | PermissionEvent
    | { type: string };

// ── UI display items ──────────────────────────────────────────────────────────

export interface ToolCall {
    name: string;
    input: unknown;
    toolUseId: string;
}

export type Item =
    | { kind: 'user'; text: string; id: string }
    | { kind: 'assistant'; text: string; id: string; streaming?: boolean }
    | { kind: 'tools'; calls: ToolCall[]; id: string }
    | { kind: 'result'; text: string; success: boolean; id: string }
    | { kind: 'status'; text: string; id: string };

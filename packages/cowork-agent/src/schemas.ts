import { z } from 'zod';

// ─── Phase 1: Handshake (webapp → agent) ─────────────────────────────────────

export const HelloFirstTimeSchema = z
    .object({
        type: z.literal('hello'),
        nonce: z.string().min(1),
        webappPublicKey: z.string().min(1),
    })
    .strict();

export const HelloReconnectSchema = z
    .object({
        type: z.literal('hello'),
        sessionCredential: z.string().min(1),
        webappPublicKey: z.string().min(1),
        lastSeq: z.number().int(),
    })
    .strict();

export const HandshakeInboundSchema = z.union([HelloFirstTimeSchema, HelloReconnectSchema]);

// ─── Phase 2: Session (webapp → agent) ───────────────────────────────────────

export const InputSchema = z
    .object({
        type: z.literal('input'),
        text: z.string(),
    })
    .strict();

export const RpcRequestSchema = z
    .object({
        type: z.literal('rpc'),
        id: z.string().min(1),
        method: z.string().min(1),
        params: z.unknown(),
    })
    .strict();

export const PongSchema = z.object({ type: z.literal('pong') }).strict();

export const SessionInboundSchema = z.discriminatedUnion('type', [
    InputSchema,
    RpcRequestSchema,
    PongSchema,
]);

// ─── Inferred TS types ───────────────────────────────────────────────────────

export type HelloFirstTime = z.infer<typeof HelloFirstTimeSchema>;
export type HelloReconnect = z.infer<typeof HelloReconnectSchema>;
export type HandshakeInbound = z.infer<typeof HandshakeInboundSchema>;

export type InputMessage = z.infer<typeof InputSchema>;
export type RpcRequestMessage = z.infer<typeof RpcRequestSchema>;
export type PongMessage = z.infer<typeof PongSchema>;
export type SessionInbound = z.infer<typeof SessionInboundSchema>;

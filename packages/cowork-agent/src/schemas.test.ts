import { describe, expect, it } from 'vitest';
import { HandshakeInboundSchema, SessionInboundSchema } from './schemas.js';

describe('HandshakeInboundSchema', () => {
    it('accepts first-time hello', () => {
        const ok = HandshakeInboundSchema.safeParse({
            type: 'hello',
            nonce: 'abc',
            webappPublicKey: 'pk',
        });
        expect(ok.success).toBe(true);
    });

    it('accepts reconnect hello with per-session lastSeqs map', () => {
        const ok = HandshakeInboundSchema.safeParse({
            type: 'hello',
            sessionCredential: '{"payload":"x","signature":"y"}',
            webappPublicKey: 'pk',
            lastSeqs: { 'sess-1': 42, 'sess-2': -1 },
        });
        expect(ok.success).toBe(true);
    });

    it('accepts reconnect hello with empty lastSeqs object', () => {
        const ok = HandshakeInboundSchema.safeParse({
            type: 'hello',
            sessionCredential: 'c',
            webappPublicKey: 'pk',
            lastSeqs: {},
        });
        expect(ok.success).toBe(true);
    });

    it('rejects hello with missing fields', () => {
        expect(HandshakeInboundSchema.safeParse({ type: 'hello' }).success).toBe(false);
        expect(HandshakeInboundSchema.safeParse({ type: 'hello', nonce: 'a' }).success).toBe(false);
    });

    it('rejects hello with empty strings', () => {
        expect(
            HandshakeInboundSchema.safeParse({
                type: 'hello',
                nonce: '',
                webappPublicKey: 'pk',
            }).success,
        ).toBe(false);
    });

    it('rejects hello with non-string fields', () => {
        expect(
            HandshakeInboundSchema.safeParse({
                type: 'hello',
                nonce: 123,
                webappPublicKey: 'pk',
            }).success,
        ).toBe(false);
        expect(
            HandshakeInboundSchema.safeParse({
                type: 'hello',
                nonce: null,
                webappPublicKey: 'pk',
            }).success,
        ).toBe(false);
    });

    it('rejects reconnect hello with non-int lastSeqs values', () => {
        expect(
            HandshakeInboundSchema.safeParse({
                type: 'hello',
                sessionCredential: 'c',
                webappPublicKey: 'pk',
                lastSeqs: { A: 1.5 },
            }).success,
        ).toBe(false);
    });

    it('rejects non-hello types', () => {
        expect(HandshakeInboundSchema.safeParse({ type: 'input', text: 'hi' }).success).toBe(false);
        expect(HandshakeInboundSchema.safeParse({ type: 'pong' }).success).toBe(false);
    });

    it('rejects hello with extra unknown fields (strict mode)', () => {
        expect(
            HandshakeInboundSchema.safeParse({
                type: 'hello',
                nonce: 'a',
                webappPublicKey: 'pk',
                injected: 'bad',
            }).success,
        ).toBe(false);
    });

    it('rejects non-objects', () => {
        expect(HandshakeInboundSchema.safeParse(null).success).toBe(false);
        expect(HandshakeInboundSchema.safeParse('hello').success).toBe(false);
        expect(HandshakeInboundSchema.safeParse([]).success).toBe(false);
    });
});

describe('SessionInboundSchema', () => {
    it('accepts input with sessionId', () => {
        expect(
            SessionInboundSchema.safeParse({ type: 'input', sessionId: 's1', text: 'hi' }).success,
        ).toBe(true);
    });

    it('accepts empty-string text (protocol does not enforce non-empty)', () => {
        expect(
            SessionInboundSchema.safeParse({ type: 'input', sessionId: 's1', text: '' }).success,
        ).toBe(true);
    });

    it('rejects input without sessionId', () => {
        expect(SessionInboundSchema.safeParse({ type: 'input', text: 'hi' }).success).toBe(false);
    });

    it('rejects input with empty sessionId', () => {
        expect(
            SessionInboundSchema.safeParse({ type: 'input', sessionId: '', text: 'hi' }).success,
        ).toBe(false);
    });

    it('accepts rpc with any params shape', () => {
        expect(
            SessionInboundSchema.safeParse({
                type: 'rpc',
                id: 'r1',
                method: 'session.list',
                params: {},
            }).success,
        ).toBe(true);
        expect(
            SessionInboundSchema.safeParse({
                type: 'rpc',
                id: 'r1',
                method: 'foo',
                params: { deep: { nested: [1, 2, 3] } },
            }).success,
        ).toBe(true);
    });

    it('accepts pong', () => {
        expect(SessionInboundSchema.safeParse({ type: 'pong' }).success).toBe(true);
    });

    it('rejects hello (handshake message in session phase)', () => {
        expect(
            SessionInboundSchema.safeParse({
                type: 'hello',
                nonce: 'a',
                webappPublicKey: 'pk',
            }).success,
        ).toBe(false);
    });

    it('rejects rpc with empty id or method', () => {
        expect(
            SessionInboundSchema.safeParse({
                type: 'rpc',
                id: '',
                method: 'abort',
                params: {},
            }).success,
        ).toBe(false);
        expect(
            SessionInboundSchema.safeParse({
                type: 'rpc',
                id: 'r1',
                method: '',
                params: {},
            }).success,
        ).toBe(false);
    });

    it('rejects unknown message type', () => {
        expect(SessionInboundSchema.safeParse({ type: 'haxx', evil: true }).success).toBe(false);
    });

    it('rejects pong with extra fields (strict mode)', () => {
        expect(SessionInboundSchema.safeParse({ type: 'pong', spy: 1 }).success).toBe(false);
    });

    it('rejects input without text field', () => {
        expect(SessionInboundSchema.safeParse({ type: 'input', sessionId: 's' }).success).toBe(false);
    });

    it('rejects input with non-string text', () => {
        expect(
            SessionInboundSchema.safeParse({ type: 'input', sessionId: 's', text: 42 }).success,
        ).toBe(false);
        expect(
            SessionInboundSchema.safeParse({ type: 'input', sessionId: 's', text: null }).success,
        ).toBe(false);
    });
});

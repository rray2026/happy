import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    buildQRPayload,
    generateCliKeys,
    issueCredential,
    verifyCredential,
    verifyNonce,
} from './auth.js';
import { encodeBase64 } from './encoding.js';
import type { SessionCredentialPayload } from './types.js';

describe('generateCliKeys', () => {
    it('returns a 32-byte pub key and 64-byte secret key', () => {
        const keys = generateCliKeys();
        expect(keys.signPublicKey).toHaveLength(32);
        expect(keys.signSecretKey).toHaveLength(64);
    });

    it('produces distinct keypairs', () => {
        const a = generateCliKeys();
        const b = generateCliKeys();
        expect(a.signPublicKey).not.toEqual(b.signPublicKey);
    });
});

describe('buildQRPayload', () => {
    it('embeds endpoint + sessionId verbatim', () => {
        const keys = generateCliKeys();
        const sid = randomUUID();
        const p = buildQRPayload('wss://example.com', keys, sid);
        expect(p.type).toBe('direct');
        expect(p.endpoint).toBe('wss://example.com');
        expect(p.sessionId).toBe(sid);
    });

    it('produces a fresh nonce each call', () => {
        const keys = generateCliKeys();
        const a = buildQRPayload('ws://x', keys, randomUUID());
        const b = buildQRPayload('ws://x', keys, randomUUID());
        expect(a.nonce).not.toBe(b.nonce);
    });

    it('sets nonceExpiry ~5 minutes in the future', () => {
        const keys = generateCliKeys();
        const before = Date.now();
        const p = buildQRPayload('ws://x', keys, randomUUID());
        const after = Date.now();
        const FIVE_MIN = 5 * 60 * 1000;
        expect(p.nonceExpiry).toBeGreaterThanOrEqual(before + FIVE_MIN - 50);
        expect(p.nonceExpiry).toBeLessThanOrEqual(after + FIVE_MIN + 50);
    });
});

describe('verifyNonce', () => {
    it('passes when nonce matches, not expired, not consumed', () => {
        expect(verifyNonce('n', 'n', Date.now() + 60_000, false)).toBe(true);
    });
    it('fails on mismatch', () => {
        expect(verifyNonce('a', 'b', Date.now() + 60_000, false)).toBe(false);
    });
    it('fails when expired', () => {
        expect(verifyNonce('n', 'n', Date.now() - 1, false)).toBe(false);
    });
    it('fails when already consumed (one-time)', () => {
        expect(verifyNonce('n', 'n', Date.now() + 60_000, true)).toBe(false);
    });
    it('fails when empty strings (defence in depth)', () => {
        expect(verifyNonce('', '', Date.now() + 60_000, false)).toBe(false);
    });
});

describe('issueCredential + verifyCredential', () => {
    it('round-trips', () => {
        const keys = generateCliKeys();
        const sid = randomUUID();
        const cred = issueCredential('wpub', sid, keys.signSecretKey);
        const res = verifyCredential(cred, keys.signPublicKey);
        expect(res?.sessionId).toBe(sid);
        expect(res?.webappPublicKey).toBe('wpub');
    });

    it('rejects wrong public key', () => {
        const a = generateCliKeys();
        const b = generateCliKeys();
        const cred = issueCredential('k', randomUUID(), a.signSecretKey);
        expect(verifyCredential(cred, b.signPublicKey)).toBeNull();
    });

    it('rejects tampered payload', () => {
        const keys = generateCliKeys();
        const cred = issueCredential('k', randomUUID(), keys.signSecretKey);
        const parsed = JSON.parse(cred);
        const payload = JSON.parse(parsed.payload) as SessionCredentialPayload;
        payload.webappPublicKey = 'attacker';
        parsed.payload = JSON.stringify(payload);
        expect(verifyCredential(JSON.stringify(parsed), keys.signPublicKey)).toBeNull();
    });

    it('rejects expired credentials', () => {
        const keys = generateCliKeys();
        const payload: SessionCredentialPayload = {
            webappPublicKey: 'k',
            sessionId: randomUUID(),
            expiry: Date.now() - 1,
        };
        const payloadJson = JSON.stringify(payload);
        const sig = tweetnacl.sign.detached(
            new TextEncoder().encode(payloadJson),
            keys.signSecretKey,
        );
        const cred = JSON.stringify({ payload: payloadJson, signature: encodeBase64(sig) });
        expect(verifyCredential(cred, keys.signPublicKey)).toBeNull();
    });

    it('rejects malformed JSON', () => {
        const keys = generateCliKeys();
        expect(verifyCredential('not-json', keys.signPublicKey)).toBeNull();
        expect(verifyCredential('{}', keys.signPublicKey)).toBeNull();
    });
});

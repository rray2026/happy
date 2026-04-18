import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@/api/encryption';
import {
    generateCliKeys,
    buildQRPayload,
    verifyNonce,
    issueCredential,
    verifyCredential,
} from './directAuth';
import type { SessionCredentialPayload } from './types';

describe('generateCliKeys', () => {
    it('returns public key of 32 bytes and secret key of 64 bytes', () => {
        const keys = generateCliKeys();
        expect(keys.signPublicKey).toBeInstanceOf(Uint8Array);
        expect(keys.signPublicKey).toHaveLength(32);
        expect(keys.signSecretKey).toBeInstanceOf(Uint8Array);
        expect(keys.signSecretKey).toHaveLength(64);
    });

    it('produces a different keypair on each call', () => {
        const a = generateCliKeys();
        const b = generateCliKeys();
        expect(a.signPublicKey).not.toEqual(b.signPublicKey);
        expect(a.signSecretKey).not.toEqual(b.signSecretKey);
    });
});

describe('buildQRPayload', () => {
    it('sets type to "direct"', () => {
        const keys = generateCliKeys();
        const payload = buildQRPayload('ws://localhost:4000', keys, randomUUID());
        expect(payload.type).toBe('direct');
    });

    it('embeds the endpoint verbatim', () => {
        const keys = generateCliKeys();
        const endpoint = 'wss://example.com/happy';
        const payload = buildQRPayload(endpoint, keys, randomUUID());
        expect(payload.endpoint).toBe(endpoint);
    });

    it('embeds the sessionId verbatim', () => {
        const keys = generateCliKeys();
        const sessionId = randomUUID();
        const payload = buildQRPayload('ws://localhost', keys, sessionId);
        expect(payload.sessionId).toBe(sessionId);
    });

    it('includes a non-empty base64-encoded nonce', () => {
        const keys = generateCliKeys();
        const payload = buildQRPayload('ws://localhost', keys, randomUUID());
        expect(typeof payload.nonce).toBe('string');
        expect(payload.nonce.length).toBeGreaterThan(0);
    });

    it('generates a different nonce on each call', () => {
        const keys = generateCliKeys();
        const a = buildQRPayload('ws://localhost', keys, randomUUID());
        const b = buildQRPayload('ws://localhost', keys, randomUUID());
        expect(a.nonce).not.toBe(b.nonce);
    });

    it('sets nonceExpiry roughly 5 minutes in the future', () => {
        const keys = generateCliKeys();
        const before = Date.now();
        const payload = buildQRPayload('ws://localhost', keys, randomUUID());
        const after = Date.now();
        const FIVE_MIN_MS = 5 * 60 * 1000;
        expect(payload.nonceExpiry).toBeGreaterThanOrEqual(before + FIVE_MIN_MS - 100);
        expect(payload.nonceExpiry).toBeLessThanOrEqual(after + FIVE_MIN_MS + 100);
    });

    it('encodes the CLI public key as base64 (≥40 chars for 32 bytes)', () => {
        const keys = generateCliKeys();
        const payload = buildQRPayload('ws://localhost', keys, randomUUID());
        expect(payload.cliSignPublicKey.length).toBeGreaterThanOrEqual(40);
    });
});

describe('verifyNonce', () => {
    it('returns true when nonce matches and has not expired', () => {
        const nonce = 'test-nonce-abc';
        expect(verifyNonce(nonce, nonce, Date.now() + 60_000)).toBe(true);
    });

    it('returns false when received nonce does not match', () => {
        expect(verifyNonce('wrong', 'real', Date.now() + 60_000)).toBe(false);
    });

    it('returns false when nonce is already expired', () => {
        const nonce = 'test-nonce';
        expect(verifyNonce(nonce, nonce, Date.now() - 1)).toBe(false);
    });

    it('returns false when expiry is exactly 0', () => {
        const nonce = 'abc';
        expect(verifyNonce(nonce, nonce, 0)).toBe(false);
    });
});

describe('issueCredential + verifyCredential', () => {
    it('round-trip: issued credential verifies successfully', () => {
        const keys = generateCliKeys();
        const sessionId = randomUUID();
        const webappPublicKey = 'webapp-pub-key-xyz';

        const credential = issueCredential(webappPublicKey, sessionId, keys.signSecretKey);
        const result = verifyCredential(credential, keys.signPublicKey);

        expect(result).not.toBeNull();
        expect(result?.sessionId).toBe(sessionId);
        expect(result?.webappPublicKey).toBe(webappPublicKey);
    });

    it('expiry is roughly 30 days in the future', () => {
        const keys = generateCliKeys();
        const credential = issueCredential('key', randomUUID(), keys.signSecretKey);
        const result = verifyCredential(credential, keys.signPublicKey);
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        expect(result?.expiry).toBeGreaterThan(Date.now() + THIRTY_DAYS_MS - 5_000);
        expect(result?.expiry).toBeLessThan(Date.now() + THIRTY_DAYS_MS + 5_000);
    });

    it('returns null when verified with a wrong public key', () => {
        const keys = generateCliKeys();
        const other = generateCliKeys();
        const credential = issueCredential('key', randomUUID(), keys.signSecretKey);
        expect(verifyCredential(credential, other.signPublicKey)).toBeNull();
    });

    it('returns null when the payload is tampered after signing', () => {
        const keys = generateCliKeys();
        const credential = issueCredential('key', randomUUID(), keys.signSecretKey);

        const parsed = JSON.parse(credential);
        const payload: SessionCredentialPayload = JSON.parse(parsed.payload);
        payload.webappPublicKey = 'attacker-key';
        parsed.payload = JSON.stringify(payload);
        const tampered = JSON.stringify(parsed);

        expect(verifyCredential(tampered, keys.signPublicKey)).toBeNull();
    });

    it('returns null when the credential is expired', () => {
        const keys = generateCliKeys();
        const sessionId = randomUUID();

        // Craft a credential with a valid signature but an already-expired expiry
        const expiredPayloadObj: SessionCredentialPayload = {
            webappPublicKey: 'key',
            sessionId,
            expiry: Date.now() - 1,
        };
        const expiredPayloadJson = JSON.stringify(expiredPayloadObj);
        const payloadBytes = new TextEncoder().encode(expiredPayloadJson);
        const signature = tweetnacl.sign.detached(payloadBytes, keys.signSecretKey);
        const expiredCredential = JSON.stringify({
            payload: expiredPayloadJson,
            signature: encodeBase64(signature),
        });

        expect(verifyCredential(expiredCredential, keys.signPublicKey)).toBeNull();
    });

    it('returns null for malformed JSON', () => {
        const keys = generateCliKeys();
        expect(verifyCredential('not-json', keys.signPublicKey)).toBeNull();
    });

    it('returns null for an object missing required fields', () => {
        const keys = generateCliKeys();
        expect(verifyCredential('{}', keys.signPublicKey)).toBeNull();
        expect(verifyCredential('{"payload":"x"}', keys.signPublicKey)).toBeNull();
    });
});

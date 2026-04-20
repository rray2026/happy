import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import tweetnacl from 'tweetnacl';
import { encodeBase64, decodeBase64, getRandomBytes } from '@/api/encryption';
import type { CliKeys, DirectQRPayload, SessionCredentialPayload } from './types';

const NONCE_TTL_MS = 5 * 60 * 1000;   // QR nonce valid for 5 minutes
const CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // session credential valid for 30 days

/**
 * Load a persisted Ed25519 keypair from disk, or generate a new one and save it.
 * Persisting the keypair means webapps can reconnect across CLI restarts without
 * re-scanning the QR code — their stored sessionCredential is still verifiable.
 */
export function loadOrGenerateCliKeys(keyPath: string): CliKeys {
    try {
        if (existsSync(keyPath)) {
            const stored = JSON.parse(readFileSync(keyPath, 'utf8')) as { signPublicKey: string; signSecretKey: string };
            return {
                signPublicKey: decodeBase64(stored.signPublicKey),
                signSecretKey: decodeBase64(stored.signSecretKey),
            };
        }
    } catch {
        // fall through to generate new keys
    }
    const kp = tweetnacl.sign.keyPair();
    const keys: CliKeys = { signPublicKey: kp.publicKey, signSecretKey: kp.secretKey };
    writeFileSync(keyPath, JSON.stringify({
        signPublicKey: encodeBase64(keys.signPublicKey),
        signSecretKey: encodeBase64(keys.signSecretKey),
    }), 'utf8');
    return keys;
}

/** Build the JSON object that will be encoded into the terminal QR code */
export function buildQRPayload(
    endpoint: string,
    cliKeys: CliKeys,
    sessionId: string,
): DirectQRPayload {
    const nonce = getRandomBytes(32);
    return {
        type: 'direct',
        endpoint,
        cliSignPublicKey: encodeBase64(cliKeys.signPublicKey),
        sessionId,
        nonce: encodeBase64(nonce),
        nonceExpiry: Date.now() + NONCE_TTL_MS,
    };
}

/** True if the nonce matches the one in the QR payload and has not expired */
export function verifyNonce(
    receivedNonce: string,
    qrNonce: string,
    nonceExpiry: number,
): boolean {
    if (Date.now() > nonceExpiry) return false;
    return receivedNonce === qrNonce;
}

/**
 * Issue a signed credential for the webapp.
 * The credential is a JSON string (payload + detached signature) so the
 * webapp can store it as-is and present it on reconnect.
 */
export function issueCredential(
    webappPublicKey: string,
    sessionId: string,
    cliSignSecretKey: Uint8Array,
): string {
    const payload: SessionCredentialPayload = {
        webappPublicKey,
        sessionId,
        expiry: Date.now() + CREDENTIAL_TTL_MS,
    };
    const payloadJson = JSON.stringify(payload);
    const payloadBytes = new TextEncoder().encode(payloadJson);
    const signature = tweetnacl.sign.detached(payloadBytes, cliSignSecretKey);
    return JSON.stringify({ payload: payloadJson, signature: encodeBase64(signature) });
}

/**
 * Verify a credential presented by the webapp on reconnect.
 * Returns the parsed payload on success, or null if invalid/expired/tampered.
 */
export function verifyCredential(
    credential: string,
    cliSignPublicKey: Uint8Array,
): SessionCredentialPayload | null {
    try {
        const { payload: payloadJson, signature: signatureB64 } = JSON.parse(credential);
        const payloadBytes = new TextEncoder().encode(payloadJson);
        const signature = decodeBase64(signatureB64);
        if (!tweetnacl.sign.detached.verify(payloadBytes, signature, cliSignPublicKey)) {
            return null;
        }
        const payload: SessionCredentialPayload = JSON.parse(payloadJson);
        if (Date.now() > payload.expiry) return null;
        return payload;
    } catch {
        return null;
    }
}

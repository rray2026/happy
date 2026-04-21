import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64, getRandomBytes } from './encoding.js';
import { logger } from './logger.js';
import type { CliKeys, DirectQRPayload, SessionCredentialPayload } from './types.js';

const NONCE_TTL_MS = 5 * 60 * 1000;
const CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generateCliKeys(): CliKeys & { sessionId: string } {
    const kp = tweetnacl.sign.keyPair();
    return {
        signPublicKey: kp.publicKey,
        signSecretKey: kp.secretKey,
        sessionId: randomUUID(),
    };
}

export function loadOrGenerateCliKeys(keyPath: string): CliKeys & { sessionId: string } {
    try {
        if (existsSync(keyPath)) {
            // Warn & tighten permissions if the key file is group/world-readable.
            if (process.platform !== 'win32') {
                try {
                    const mode = statSync(keyPath).mode & 0o777;
                    if (mode & 0o077) {
                        logger.debug(
                            `[auth] key file ${keyPath} has loose permissions ${mode.toString(8)}; tightening to 600`,
                        );
                        chmodSync(keyPath, 0o600);
                    }
                } catch (err) {
                    logger.debug('[auth] failed to check/fix key file permissions:', (err as Error).message);
                }
            }
            const stored = JSON.parse(readFileSync(keyPath, 'utf8')) as {
                signPublicKey: string;
                signSecretKey: string;
                sessionId: string;
            };
            return {
                signPublicKey: decodeBase64(stored.signPublicKey),
                signSecretKey: decodeBase64(stored.signSecretKey),
                sessionId: stored.sessionId,
            };
        }
    } catch {
        // fall through and regenerate
    }
    const kp = tweetnacl.sign.keyPair();
    const sessionId = randomUUID();
    writeFileSync(
        keyPath,
        JSON.stringify({
            signPublicKey: encodeBase64(kp.publicKey),
            signSecretKey: encodeBase64(kp.secretKey),
            sessionId,
        }),
        { encoding: 'utf8', mode: 0o600 },
    );
    return { signPublicKey: kp.publicKey, signSecretKey: kp.secretKey, sessionId };
}

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

export function verifyNonce(
    receivedNonce: string,
    qrNonce: string,
    nonceExpiry: number,
    consumed: boolean,
): boolean {
    if (consumed) return false;
    if (Date.now() > nonceExpiry) return false;
    if (!qrNonce || !receivedNonce) return false;
    return receivedNonce === qrNonce;
}

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

export function verifyCredential(
    credential: string,
    cliSignPublicKey: Uint8Array,
): SessionCredentialPayload | null {
    try {
        const { payload: payloadJson, signature: signatureB64 } = JSON.parse(credential);
        if (typeof payloadJson !== 'string' || typeof signatureB64 !== 'string') return null;
        const payloadBytes = new TextEncoder().encode(payloadJson);
        const signature = decodeBase64(signatureB64);
        if (!tweetnacl.sign.detached.verify(payloadBytes, signature, cliSignPublicKey)) {
            return null;
        }
        const payload = JSON.parse(payloadJson) as SessionCredentialPayload;
        if (!payload?.sessionId || !payload?.webappPublicKey || typeof payload.expiry !== 'number') {
            return null;
        }
        if (Date.now() > payload.expiry) return null;
        return payload;
    } catch {
        return null;
    }
}

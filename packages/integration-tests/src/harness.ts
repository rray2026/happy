import { WebSocket as NodeWs } from 'ws';
import { buildQRPayload, generateCliKeys } from '../../cowork-agent/src/auth.js';
import { startWsServer } from '../../cowork-agent/src/wsServer.js';
import type { CliKeys, WsServerHandle } from '../../cowork-agent/src/types.js';
import { SessionClient } from '../../cowork-webapp/src/session/client';
import { createMemoryStorage, type CredentialStorage } from '../../cowork-webapp/src/session/storage';
import type { DirectQRPayload, StoredCredentials } from '../../cowork-webapp/src/types';

/**
 * A full vertical slice: real agent WebSocket server + real webapp SessionClient
 * connected via the `ws` library (Node's WebSocket). No fakes in between.
 */
export interface E2ERig {
    server: WsServerHandle;
    endpoint: string;
    sessionId: string;
    cliKeys: CliKeys;
    /** QR payload with the actual bound endpoint; hand to `connectFirstTime`. */
    qrPayload: DirectQRPayload;
    /** Collected `input.text` values seen by the agent. */
    inputs: string[];
    /** Collected rpc calls seen by the agent. */
    rpcCalls: Array<{ id: string; method: string; params: unknown }>;
    /** Optional custom rpc responder — defaults to echoing `{ ok: true }`. */
    setRpcResponder(fn: (id: string, method: string, params: unknown) => void): void;
    makeClient(seedCreds?: StoredCredentials | null): {
        client: SessionClient;
        storage: CredentialStorage;
    };
    dispose(): Promise<void>;
}

export async function startRig(): Promise<E2ERig> {
    const cliKeys = generateCliKeys();
    const sessionId = cliKeys.sessionId;
    const inputs: string[] = [];
    const rpcCalls: Array<{ id: string; method: string; params: unknown }> = [];
    // The QR payload is handed to startWsServer *before* we know the real port —
    // the server only uses `nonce`/`nonceExpiry` from it, so the endpoint field
    // is cosmetic here and we overwrite it for the client below.
    const qrPayloadForServer = buildQRPayload('ws://127.0.0.1:0', cliKeys, sessionId);

    let rpcResponder: (id: string, method: string, params: unknown) => void = (id) => {
        server.sendRpcResponse(id, { ok: true });
    };

    const server = startWsServer({
        port: 0,
        host: '127.0.0.1',
        sessionId,
        cliKeys,
        qrPayload: qrPayloadForServer,
        onInput: (text) => inputs.push(text),
        onRpc: async (id, method, params) => {
            rpcCalls.push({ id, method, params });
            rpcResponder(id, method, params);
        },
    });
    await server.ready();
    const port = server.port();
    const endpoint = `ws://127.0.0.1:${port}`;
    const qrPayload: DirectQRPayload = { ...qrPayloadForServer, endpoint };

    return {
        server,
        endpoint,
        sessionId,
        cliKeys,
        qrPayload,
        inputs,
        rpcCalls,
        setRpcResponder(fn) { rpcResponder = fn; },
        makeClient(seedCreds = null) {
            const storage = createMemoryStorage({
                creds: seedCreds,
                webappKey: 'wa-pub',
            });
            const client = new SessionClient({
                storage,
                createWebSocket: (url) => new NodeWs(url) as unknown as WebSocket,
                pageProtocol: () => 'http:',
                initialReconnectDelayMs: 50,
                maxReconnectDelayMs: 200,
                rpcTimeoutMs: 1_000,
            });
            return { client, storage };
        },
        async dispose() {
            server.close();
        },
    };
}

// ── Small async helpers ────────────────────────────────────────────────────────

export function waitForStatus(
    client: SessionClient,
    target: 'connected' | 'disconnected' | 'error' | 'connecting',
    timeoutMs = 2_000,
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (client.getStatus() === target) return resolve();
        const t = setTimeout(() => {
            unsub();
            reject(
                new Error(
                    `timed out waiting for status=${target}; last=${client.getStatus()}; err=${client.getLastError()}`,
                ),
            );
        }, timeoutMs);
        const unsub = client.onStatusChange((s) => {
            if (s === target) {
                clearTimeout(t);
                unsub();
                resolve();
            }
        });
    });
}

export function waitFor<T>(
    fn: () => T | null | undefined | false,
    timeoutMs = 2_000,
    intervalMs = 10,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            const v = fn();
            if (v) return resolve(v as T);
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
            }
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as NodeWs } from 'ws';
import { wireAgentToServer, type AgentType, type WireHandle } from '../../cowork-agent/src/assemble.js';
import { buildQRPayload, generateCliKeys } from '../../cowork-agent/src/auth.js';
import { startWsServer } from '../../cowork-agent/src/wsServer.js';
import type { CliKeys, WsServerHandle } from '../../cowork-agent/src/types.js';
import { SessionClient } from '../../cowork-webapp/src/session/client';
import { eventToItems, mergeItems } from '../../cowork-webapp/src/session/events';
import { createMemoryStorage, type CredentialStorage } from '../../cowork-webapp/src/session/storage';
import type { ClaudeEvent, DirectQRPayload, Item, StoredCredentials } from '../../cowork-webapp/src/types';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const FAKE_CLAUDE = join(FIXTURES_DIR, 'fake-claude.mjs');
export const FAKE_GEMINI = join(FIXTURES_DIR, 'fake-gemini-acp.mjs');

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

// ── CLI end-to-end rig (fake claude / fake gemini → wsServer → webapp) ─────────

export interface CliRigOptions {
    agent: AgentType;
    /** JSON script consumed by the fake CLI script. */
    cliScript: unknown;
    /** Pre-existing gemini session id to resume (only meaningful for gemini). */
    resumeSessionId?: string;
    /** When true, the fake gemini accepts `session/load` (else returns error). */
    acpLoadOk?: boolean;
    /** Override the claude binary (default: fake-claude.mjs). */
    claudeCommand?: string;
    /** Override the gemini binary (default: fake-gemini-acp.mjs). */
    geminiCommand?: string;
}

export interface CliRig {
    endpoint: string;
    server: WsServerHandle;
    client: SessionClient;
    storage: CredentialStorage;
    wire: WireHandle;
    /** Every event the client sees, in order. */
    events: Array<{ payload: unknown; seq: number }>;
    /** Webapp-layer UI items produced by eventToItems + mergeItems. */
    items: Item[];
    sendInput(text: string): void;
    dispose(): Promise<void>;
}

/**
 * Full-path rig: spawns a fake claude/gemini CLI, routes its output through a
 * real wsServer to a real webapp SessionClient, and also runs the webapp-side
 * event reducer (eventToItems + mergeItems) so tests can assert both the
 * protocol layer (`events`) and the rendering layer (`items`).
 */
export async function startCliRig(opts: CliRigOptions): Promise<CliRig> {
    const cliKeys = generateCliKeys();
    const { sessionId } = cliKeys;
    const qrPayloadForServer = buildQRPayload('ws://127.0.0.1:0', cliKeys, sessionId);

    // Write the CLI script to a tmp file the fake binary reads via env.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cowork-cli-rig-'));
    const scriptFile = join(tmpRoot, 'script.json');
    writeFileSync(scriptFile, JSON.stringify(opts.cliScript), 'utf8');

    const claudeCommand = opts.agent === 'claude' ? opts.claudeCommand ?? FAKE_CLAUDE : undefined;
    const geminiCommand = opts.agent === 'gemini' ? opts.geminiCommand ?? FAKE_GEMINI : undefined;
    const claudeExtraEnv =
        opts.agent === 'claude' ? { FAKE_CLI_SCRIPT: scriptFile } : undefined;
    const geminiExtraEnv =
        opts.agent === 'gemini'
            ? {
                  FAKE_ACP_SCRIPT: scriptFile,
                  ...(opts.acpLoadOk ? { FAKE_ACP_LOAD_OK: '1' } : {}),
              }
            : undefined;

    let wire!: WireHandle;
    const server = startWsServer({
        port: 0,
        host: '127.0.0.1',
        sessionId,
        cliKeys,
        qrPayload: qrPayloadForServer,
        onInput: (text) => {
            wire.handleInput(text).catch(() => {
                /* errors surface via the result event broadcast */
            });
        },
        onRpc: (id, method, params) => wire.handleRpc(id, method, params),
    });
    await server.ready();
    const endpoint = `ws://127.0.0.1:${server.port()}`;
    const qrPayload: DirectQRPayload = { ...qrPayloadForServer, endpoint };

    wire = wireAgentToServer({
        agent: opts.agent,
        server,
        resumeSessionId: opts.resumeSessionId,
        claudeCommand,
        claudeExtraEnv,
        geminiCommand,
        geminiExtraEnv,
    });

    const storage = createMemoryStorage({ creds: null, webappKey: 'wa-pub' });
    const client = new SessionClient({
        storage,
        createWebSocket: (url) => new NodeWs(url) as unknown as WebSocket,
        pageProtocol: () => 'http:',
        initialReconnectDelayMs: 50,
        maxReconnectDelayMs: 200,
        rpcTimeoutMs: 2_000,
    });

    const events: Array<{ payload: unknown; seq: number }> = [];
    let items: Item[] = [];
    client.onMessage((payload, seq) => {
        events.push({ payload, seq });
        items = mergeItems(items, eventToItems(payload as ClaudeEvent));
    });

    client.connectFirstTime(qrPayload, 'wa-pub');
    await waitForStatus(client, 'connected', 3_000);

    const rig: CliRig = {
        endpoint,
        server,
        client,
        storage,
        wire,
        events,
        get items() {
            return items;
        },
        sendInput(text: string) {
            client.sendInput(text);
        },
        async dispose() {
            try {
                client.disconnect();
            } catch {
                /* ignore */
            }
            wire.dispose();
            server.close();
            try {
                rmSync(tmpRoot, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        },
    };
    return rig;
}

/**
 * Wait until an event matching `predicate` has been collected by `rig.events`.
 * Resolves with the matching entry.
 */
export function waitForEvent(
    rig: { events: Array<{ payload: unknown; seq: number }> },
    predicate: (payload: unknown, seq: number) => boolean,
    timeoutMs = 3_000,
): Promise<{ payload: unknown; seq: number }> {
    return waitFor(
        () => rig.events.find((e) => predicate(e.payload, e.seq)) ?? null,
        timeoutMs,
    );
}

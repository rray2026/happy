import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as NodeWs } from 'ws';
import { buildQRPayload, generateCliKeys } from '../../cowork-agent/src/auth.js';
import { SessionManager, type Tool } from '../../cowork-agent/src/sessionManager.js';
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
 * A full vertical slice: real agent WebSocket server + a real SessionManager +
 * real webapp SessionClient, all wired via Node's WebSocket (`ws`). No fakes
 * between the agent and the client.
 *
 * One chat session is auto-created at startup so tests don't need to go through
 * the `session.create` RPC to have a target for `sendInput` and server pushes.
 */
export interface E2ERig {
    server: WsServerHandle;
    manager: SessionManager;
    endpoint: string;
    /** Connection-level session id (auth). */
    connectionSessionId: string;
    /** Chat session id of the auto-created session. */
    chatSessionId: string;
    cliKeys: CliKeys;
    /** QR payload with the actual bound endpoint; hand to `connectFirstTime`. */
    qrPayload: DirectQRPayload;
    /** Collected `input.text` values seen by the agent (for the auto-created chat session). */
    inputs: string[];
    /** Collected rpc calls seen by the agent. */
    rpcCalls: Array<{ id: string; method: string; params: unknown }>;
    /** Optional custom rpc responder — defaults to echoing `{ ok: true }`. */
    setRpcResponder(fn: (id: string, method: string, params: unknown) => void): void;
    /**
     * Inject a synthetic agent event into the auto-created chat session's
     * stream. Assigns the next seq and pushes to the connected client.
     */
    pushChatEvent(payload: unknown): void;
    makeClient(seedCreds?: StoredCredentials | null): {
        client: SessionClient;
        storage: CredentialStorage;
    };
    dispose(): Promise<void>;
}

export async function startRig(opts: { tool?: Tool } = {}): Promise<E2ERig> {
    const cliKeys = generateCliKeys();
    const connectionSessionId = cliKeys.sessionId;
    const inputs: string[] = [];
    const rpcCalls: Array<{ id: string; method: string; params: unknown }> = [];
    // The QR payload is handed to startWsServer *before* we know the real port —
    // the server only uses `nonce`/`nonceExpiry` from it, so the endpoint field
    // is cosmetic here and we overwrite it for the client below.
    const qrPayloadForServer = buildQRPayload('ws://127.0.0.1:0', cliKeys, connectionSessionId);

    let rpcResponder: (id: string, method: string, params: unknown) => void = (id) => {
        server.sendRpcResponse(id, { ok: true });
    };

    let server!: WsServerHandle;

    const manager = new SessionManager({
        cwd: process.cwd(),
        onBroadcast: (sid, seq, payload) => server.pushMessage(sid, seq, payload),
        onSessionsChanged: (sessions) => server.pushSessionsChanged(sessions),
    });

    server = startWsServer({
        port: 0,
        host: '127.0.0.1',
        sessionId: connectionSessionId,
        cliKeys,
        qrPayload: qrPayloadForServer,
        listSessions: () => manager.list(),
        replayFrom: (sid, fromSeq) => manager.replayFrom(sid, fromSeq),
        // NOTE: we intentionally do NOT dispatch to SessionManager here. The unit
        // tests drive the stream themselves via `pushChatEvent`, and we only
        // want to observe what the *client* sent.
        onInput: (_sid, text) => inputs.push(text),
        onRpc: async (id, method, params) => {
            rpcCalls.push({ id, method, params });
            rpcResponder(id, method, params);
        },
    });
    await server.ready();

    // Auto-create one chat session so tests have a stable target. Must happen
    // after `server` is assigned: create() fires onSessionsChanged, which
    // closes over `server`.
    const chat = manager.create({ tool: opts.tool ?? 'claude' });
    const chatSessionId = chat.id;
    const port = server.port();
    const endpoint = `ws://127.0.0.1:${port}`;
    const qrPayload: DirectQRPayload = { ...qrPayloadForServer, endpoint };

    return {
        server,
        manager,
        endpoint,
        connectionSessionId,
        chatSessionId,
        cliKeys,
        qrPayload,
        inputs,
        rpcCalls,
        setRpcResponder(fn) { rpcResponder = fn; },
        pushChatEvent(payload: unknown) {
            // The manager's public API only appends via `handleInput` (which
            // would spawn a real CLI subprocess) or via CLI event callbacks.
            // For unit tests we want to synthesize agent events directly, so
            // reach through the manager's private `sessions` map.
            injectEvent(manager, chatSessionId, payload, (sid, seq, p) =>
                server.pushMessage(sid, seq, p),
            );
        },
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
            manager.dispose();
            server.close();
        },
    };
}

/**
 * Internal test-only hook: append a synthetic event to a session's store and
 * broadcast it. Reaches through the SessionManager's private `sessions` map
 * via a cast; in production code we'd route through `handleInput`, but that
 * spawns a real Claude subprocess.
 */
function injectEvent(
    manager: SessionManager,
    sessionId: string,
    payload: unknown,
    broadcast: (sid: string, seq: number, payload: unknown) => void,
): void {
    const internal = manager as unknown as {
        sessions: Map<string, { store: { append: (p: unknown) => number } }>;
    };
    const entry = internal.sessions.get(sessionId);
    if (!entry) throw new Error(`injectEvent: unknown session ${sessionId}`);
    const seq = entry.store.append(payload);
    broadcast(sessionId, seq, payload);
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
    agent: Tool;
    /** JSON script consumed by the fake CLI script. */
    cliScript: unknown;
    /** Override the claude binary (default: fake-claude.mjs). */
    claudeCommand?: string;
    /** Override the gemini binary (default: fake-gemini-acp.mjs). */
    geminiCommand?: string;
}

export interface CliRig {
    endpoint: string;
    server: WsServerHandle;
    manager: SessionManager;
    client: SessionClient;
    storage: CredentialStorage;
    /** Chat session id of the auto-created session (target for `sendInput`). */
    chatSessionId: string;
    /** Every event the client sees, in order. */
    events: Array<{ sessionId: string; payload: unknown; seq: number }>;
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
 *
 * The fake CLI is driven through a real `SessionManager` — the rig creates
 * exactly one chat session at startup (the only target for `sendInput`).
 * Callers wanting multi-session scenarios can reach into `rig.manager`.
 */
export async function startCliRig(opts: CliRigOptions): Promise<CliRig> {
    const cliKeys = generateCliKeys();
    const { sessionId: connectionSessionId } = cliKeys;
    const qrPayloadForServer = buildQRPayload('ws://127.0.0.1:0', cliKeys, connectionSessionId);

    // Write the CLI script to a tmp file the fake binary reads via env.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'cowork-cli-rig-'));
    const scriptFile = join(tmpRoot, 'script.json');
    writeFileSync(scriptFile, JSON.stringify(opts.cliScript), 'utf8');

    const claudeCommand = opts.agent === 'claude' ? opts.claudeCommand ?? FAKE_CLAUDE : undefined;
    const geminiCommand = opts.agent === 'gemini' ? opts.geminiCommand ?? FAKE_GEMINI : undefined;
    const claudeExtraEnv =
        opts.agent === 'claude' ? { FAKE_CLI_SCRIPT: scriptFile } : undefined;
    const geminiExtraEnv =
        opts.agent === 'gemini' ? { FAKE_ACP_SCRIPT: scriptFile } : undefined;

    let server!: WsServerHandle;

    const manager = new SessionManager({
        cwd: process.cwd(),
        onBroadcast: (sid, seq, payload) => server.pushMessage(sid, seq, payload),
        onSessionsChanged: (sessions) => server.pushSessionsChanged(sessions),
        claudeCommand,
        claudeExtraEnv,
        geminiCommand,
        geminiExtraEnv,
    });

    server = startWsServer({
        port: 0,
        host: '127.0.0.1',
        sessionId: connectionSessionId,
        cliKeys,
        qrPayload: qrPayloadForServer,
        listSessions: () => manager.list(),
        replayFrom: (sid, fromSeq) => manager.replayFrom(sid, fromSeq),
        onInput: (sid, text) => {
            manager.handleInput(sid, text).catch(() => {
                /* errors surface via the result event broadcast */
            });
        },
        onRpc: async (id, method) => {
            // The CLI rig doesn't exercise RPC methods; reply with a no-op.
            server.sendRpcResponse(id, { ok: true, method });
        },
    });
    await server.ready();
    const endpoint = `ws://127.0.0.1:${server.port()}`;
    const qrPayload: DirectQRPayload = { ...qrPayloadForServer, endpoint };

    // Create the single chat session backing the fake CLI. Must happen AFTER
    // `server` is assigned — manager.create() fires onSessionsChanged, which
    // closes over `server`.
    const chat = manager.create({ tool: opts.agent });
    const chatSessionId = chat.id;

    const storage = createMemoryStorage({ creds: null, webappKey: 'wa-pub' });
    const client = new SessionClient({
        storage,
        createWebSocket: (url) => new NodeWs(url) as unknown as WebSocket,
        pageProtocol: () => 'http:',
        initialReconnectDelayMs: 50,
        maxReconnectDelayMs: 200,
        rpcTimeoutMs: 2_000,
    });

    const events: Array<{ sessionId: string; payload: unknown; seq: number }> = [];
    let items: Item[] = [];
    client.onMessage((sid, payload, seq) => {
        if (sid !== chatSessionId) return;
        events.push({ sessionId: sid, payload, seq });
        items = mergeItems(items, eventToItems(payload as ClaudeEvent));
    });

    client.connectFirstTime(qrPayload, 'wa-pub');
    await waitForStatus(client, 'connected', 3_000);

    const rig: CliRig = {
        endpoint,
        server,
        manager,
        client,
        storage,
        chatSessionId,
        events,
        get items() {
            return items;
        },
        sendInput(text: string) {
            client.sendInput(chatSessionId, text);
        },
        async dispose() {
            try {
                client.disconnect();
            } catch {
                /* ignore */
            }
            manager.dispose();
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

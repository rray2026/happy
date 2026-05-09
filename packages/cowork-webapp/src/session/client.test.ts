import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionClient } from './client';
import { createMemoryStorage } from './storage';
import type { DirectQRPayload, PermissionEvent, SocketStatus, StoredCredentials } from '../types';

// ── Fake WebSocket ────────────────────────────────────────────────────────────

class FakeWebSocket {
    static OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];

    readyState = 0;
    sent: string[] = [];
    url: string;

    onopen: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 3; // CLOSED
        this.onclose?.();
    }

    // ── Test helpers ──
    triggerOpen(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }
    triggerMessage(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    }
    triggerRawMessage(data: string): void {
        this.onmessage?.({ data } as MessageEvent);
    }
    triggerError(): void {
        this.onerror?.();
    }
    triggerClose(): void {
        this.readyState = 3;
        this.onclose?.();
    }
    get lastSent(): Record<string, unknown> | null {
        const raw = this.sent.at(-1);
        return raw ? JSON.parse(raw) as Record<string, unknown> : null;
    }
}

(globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = { OPEN: FakeWebSocket.OPEN };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const qrPayload: DirectQRPayload = {
    type: 'direct',
    endpoint: 'ws://localhost:9999',
    cliSignPublicKey: 'cli-pub',
    sessionId: 'conn-1',
    nonce: 'nonce-xyz',
    nonceExpiry: Number.MAX_SAFE_INTEGER,
};

const storedCreds: StoredCredentials = {
    endpoint: 'ws://localhost:9999',
    cliPublicKey: 'cli-pub',
    sessionId: 'conn-1',
    sessionCredential: 'sess-cred-123',
    lastSeqs: { 'chat-a': 42, 'chat-b': 5 },
    webappPublicKey: 'wa-pub',
};

function makeClient(opts?: {
    creds?: StoredCredentials | null;
    pageProtocol?: string;
    rpcTimeoutMs?: number;
}) {
    FakeWebSocket.instances.length = 0;
    const storage = createMemoryStorage({
        creds: opts?.creds,
        webappKey: 'wa-pub',
    });
    const client = new SessionClient({
        storage,
        createWebSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
        pageProtocol: () => opts?.pageProtocol ?? 'http:',
        rpcTimeoutMs: opts?.rpcTimeoutMs ?? 30_000,
    });
    return { client, storage, sockets: FakeWebSocket.instances };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionClient: initial state', () => {
    it('starts disconnected', () => {
        const { client } = makeClient();
        expect(client.getStatus()).toBe<SocketStatus>('disconnected');
        expect(client.getLastError()).toBeNull();
        expect(client.getLastSeq('any')).toBe(-1);
        expect(client.getSessions()).toEqual([]);
    });

    it('onStatusChange fires immediately with current status', () => {
        const { client } = makeClient();
        const statuses: SocketStatus[] = [];
        client.onStatusChange(s => statuses.push(s));
        expect(statuses).toEqual(['disconnected']);
    });
});

describe('SessionClient: first-time connect (QR)', () => {
    it('opens WebSocket to payload endpoint and enters connecting', () => {
        const { client, sockets } = makeClient();
        client.connectFirstTime(qrPayload, 'wa-pub');
        expect(sockets).toHaveLength(1);
        expect(sockets[0].url).toBe('ws://localhost:9999');
        expect(client.getStatus()).toBe('connecting');
    });

    it('sends hello with nonce on socket open', () => {
        const { client, sockets } = makeClient();
        client.connectFirstTime(qrPayload, 'wa-pub');
        sockets[0].triggerOpen();
        expect(sockets[0].lastSent).toEqual({
            type: 'hello',
            nonce: 'nonce-xyz',
            webappPublicKey: 'wa-pub',
        });
    });

    it('persists credentials and flips to connected on welcome', () => {
        const { client, sockets, storage } = makeClient();
        client.connectFirstTime(qrPayload, 'wa-pub');
        sockets[0].triggerOpen();
        sockets[0].triggerMessage({
            type: 'welcome',
            sessionCredential: 'new-cred',
            sessions: [],
        });
        expect(client.getStatus()).toBe('connected');
        expect(storage.loadCredentials()).toEqual({
            endpoint: 'ws://localhost:9999',
            cliPublicKey: 'cli-pub',
            sessionId: 'conn-1',
            sessionCredential: 'new-cred',
            lastSeqs: {},
            webappPublicKey: 'wa-pub',
        });
    });

    it('welcome exposes the session list via onSessionsChange', () => {
        const { client, sockets } = makeClient();
        client.connectFirstTime(qrPayload, 'wa-pub');

        const seen: Array<{ id: string }[]> = [];
        client.onSessionsChange((list) => seen.push(list.map((s) => ({ id: s.id }))));

        sockets[0].triggerOpen();
        sockets[0].triggerMessage({
            type: 'welcome',
            sessionCredential: 'c',
            sessions: [
                { id: 'A', tool: 'claude', model: null, cwd: '/tmp', createdAt: 1, currentSeq: 0 },
            ],
        });
        expect(client.getSessions().map((s) => s.id)).toEqual(['A']);
        expect(seen.at(-1)).toEqual([{ id: 'A' }]);
    });
});

describe('SessionClient: resume from stored', () => {
    it('sends hello with sessionCredential + stored lastSeqs map', () => {
        const { client, sockets } = makeClient();
        client.connectFromStored(storedCreds);
        sockets[0].triggerOpen();
        expect(sockets[0].lastSent).toEqual({
            type: 'hello',
            sessionCredential: 'sess-cred-123',
            webappPublicKey: 'wa-pub',
            lastSeqs: { 'chat-a': 42, 'chat-b': 5 },
        });
    });

    it('does not resave credentials on welcome when resuming', () => {
        const { client, sockets, storage } = makeClient({ creds: storedCreds });
        const saveSpy = vi.spyOn(storage, 'saveCredentials');
        client.connectFromStored(storedCreds);
        sockets[0].triggerOpen();
        sockets[0].triggerMessage({ type: 'welcome', sessions: [] });
        expect(saveSpy).not.toHaveBeenCalled();
        expect(client.getStatus()).toBe('connected');
    });

    it('is idempotent when already connected on the same credential', () => {
        // Regression: calling connectFromStored a second time after the first
        // resume completed used to wipe `this.sessions` while open() no-op'd
        // because the ws was still alive — leaving the UI with an empty list.
        const { client, sockets } = makeClient({ creds: storedCreds });
        client.connectFromStored(storedCreds);
        sockets[0].triggerOpen();
        sockets[0].triggerMessage({
            type: 'welcome',
            sessions: [
                { id: 'A', tool: 'claude', model: null, cwd: '/tmp', createdAt: 1, currentSeq: 0 },
            ],
        });
        expect(client.getSessions().map((s) => s.id)).toEqual(['A']);

        // Second call must not blow away the cached list.
        client.connectFromStored(storedCreds);
        expect(client.getSessions().map((s) => s.id)).toEqual(['A']);
        // And must not have spawned a second socket.
        expect(sockets).toHaveLength(1);
    });
});

describe('SessionClient: refreshSessions', () => {
    function connected() {
        const setup = makeClient({ creds: storedCreds });
        setup.client.connectFromStored(storedCreds);
        setup.sockets[0].triggerOpen();
        setup.sockets[0].triggerMessage({ type: 'welcome', sessions: [] });
        return setup;
    }

    it('issues a session.list rpc and updates the cached session list', async () => {
        const { client, sockets } = connected();
        const seen: Array<{ id: string }[]> = [];
        client.onSessionsChange((list) => seen.push(list.map((s) => ({ id: s.id }))));
        // Drop the immediate sync-fire so we can assert just the refresh emit.
        seen.length = 0;

        const promise = client.refreshSessions();

        // The most recent outbound frame should be the rpc envelope.
        const sent = sockets[0].lastSent!;
        expect(sent['type']).toBe('rpc');
        expect(sent['method']).toBe('session.list');
        const rpcId = sent['id'] as string;

        sockets[0].triggerMessage({
            type: 'rpc-response',
            id: rpcId,
            result: {
                sessions: [
                    { id: 'X', tool: 'claude', model: null, cwd: '/tmp', createdAt: 1, currentSeq: 0 },
                ],
            },
        });

        const result = await promise;
        expect(result.map((s) => s.id)).toEqual(['X']);
        expect(client.getSessions().map((s) => s.id)).toEqual(['X']);
        expect(seen.at(-1)).toEqual([{ id: 'X' }]);
    });

    it('returns the cached list without sending an rpc when not connected', async () => {
        const { client, sockets } = makeClient();
        const result = await client.refreshSessions();
        expect(result).toEqual([]);
        expect(sockets).toHaveLength(0);
    });
});

describe('SessionClient: per-session items cache', () => {
    function connectedWithSession(sid: string, currentSeq = -1) {
        const setup = makeClient({ creds: storedCreds });
        setup.client.connectFromStored(storedCreds);
        setup.sockets[0].triggerOpen();
        setup.sockets[0].triggerMessage({
            type: 'welcome',
            sessions: [{ id: sid, tool: 'claude', model: null, cwd: '/tmp', createdAt: 1, currentSeq }],
        });
        return setup;
    }

    it('folds incoming user/assistant events into per-session items', () => {
        const { client, sockets } = connectedWithSession('chat-a');
        const seen: number[] = [];
        client.onItemsChange('chat-a', (items) => seen.push(items.length));

        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 0,
            payload: { type: 'user', message: { role: 'user', content: 'hi' } },
        });
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 1,
            payload: {
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            },
        });

        const items = client.getItems('chat-a');
        expect(items.map((i) => i.kind)).toEqual(['user', 'assistant']);
        expect(seen.at(-1)).toBe(2);
    });

    it('drops events with stale seq (replay re-pump)', () => {
        const { client, sockets } = connectedWithSession('chat-a');
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 5,
            payload: { type: 'user', message: { role: 'user', content: 'first' } },
        });
        // A re-arrival at the same seq must NOT duplicate the user item.
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 5,
            payload: { type: 'user', message: { role: 'user', content: 'first' } },
        });
        // A lower seq (replay overlap) must also be dropped.
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 3,
            payload: { type: 'user', message: { role: 'user', content: 'older' } },
        });
        expect(client.getItems('chat-a').map((i) => i.kind)).toEqual(['user']);
    });

    it('routes per-session — chat-a events do not bleed into chat-b', () => {
        const { client, sockets } = makeClient({ creds: storedCreds });
        client.connectFromStored(storedCreds);
        sockets[0].triggerOpen();
        sockets[0].triggerMessage({
            type: 'welcome',
            sessions: [
                { id: 'chat-a', tool: 'claude', model: null, cwd: '/', createdAt: 1, currentSeq: -1 },
                { id: 'chat-b', tool: 'claude', model: null, cwd: '/', createdAt: 1, currentSeq: -1 },
            ],
        });
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 0,
            payload: { type: 'user', message: { role: 'user', content: 'a-msg' } },
        });
        expect(client.getItems('chat-a')).toHaveLength(1);
        expect(client.getItems('chat-b')).toHaveLength(0);
    });

    it('issues session.replay on first subscribe when the session has history', async () => {
        const { client, sockets } = connectedWithSession('chat-a', /* currentSeq */ 0);
        client.onItemsChange('chat-a', () => {});
        // The first outbound frame after subscribe must be the replay rpc.
        await Promise.resolve();
        const sent = sockets[0].lastSent!;
        expect(sent['type']).toBe('rpc');
        expect(sent['method']).toBe('session.replay');
        expect(sent['params']).toEqual({ sessionId: 'chat-a', fromSeq: -1 });
    });

    it('does not replay when the session has no events yet', async () => {
        const { client, sockets } = connectedWithSession('chat-a', /* currentSeq */ -1);
        const sentBefore = sockets[0].sent.length;
        client.onItemsChange('chat-a', () => {});
        await Promise.resolve();
        expect(sockets[0].sent.length).toBe(sentBefore);
    });

    it('GCs items + permission cache for a session that disappears from the list', () => {
        const { client, sockets } = connectedWithSession('chat-a');
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 0,
            payload: { type: 'user', message: { role: 'user', content: 'hi' } },
        });
        expect(client.getItems('chat-a')).toHaveLength(1);

        sockets[0].triggerMessage({ type: 'sessions', sessions: [] });
        expect(client.getItems('chat-a')).toEqual([]);
    });

    it('keeps caches across same-credential reconnect', () => {
        const { client, sockets } = connectedWithSession('chat-a');
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 0,
            payload: { type: 'user', message: { role: 'user', content: 'hi' } },
        });
        expect(client.getItems('chat-a')).toHaveLength(1);

        sockets[0].triggerClose();
        // Re-open with the same credential
        sockets[0].triggerOpen?.();
        // Calling connectFromStored mid-flight is the visible action — it
        // updates state but should NOT clear the items cache for the same
        // agent. (We don't dispatch a fresh welcome; just check the cache.)
        client.connectFromStored(storedCreds);
        expect(client.getItems('chat-a')).toHaveLength(1);
    });

    it('clears caches when connecting with a different credential', () => {
        const { client, sockets } = connectedWithSession('chat-a');
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 0,
            payload: { type: 'user', message: { role: 'user', content: 'hi' } },
        });
        expect(client.getItems('chat-a')).toHaveLength(1);

        const otherCreds = { ...storedCreds, sessionCredential: 'different' };
        client.connectFromStored(otherCreds);
        expect(client.getItems('chat-a')).toEqual([]);
    });

    it('routes permission-request payloads through onPermissionChange instead of items', () => {
        const { client, sockets } = connectedWithSession('chat-a');
        let pending: PermissionEvent | null = null;
        client.onPermissionChange('chat-a', (p) => { pending = p; });

        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 0,
            payload: {
                type: 'permission-request',
                permissionId: 'perm-1',
                toolName: 'Bash',
                input: { command: 'rm -rf' },
            },
        });
        expect(pending).toMatchObject({ type: 'permission-request', permissionId: 'perm-1' });
        expect(client.getItems('chat-a')).toEqual([]);

        client.clearPendingPermission('chat-a');
        expect(pending).toBeNull();
    });

    it('appendOptimisticUser inserts a user item before the agent echoes it back', () => {
        const { client } = connectedWithSession('chat-a');
        client.appendOptimisticUser('chat-a', 'hello agent');
        const items = client.getItems('chat-a');
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: 'user', text: 'hello agent' });
    });
});

describe('SessionClient: message handling', () => {
    function connectedClient() {
        const setup = makeClient();
        setup.client.connectFirstTime(qrPayload, 'wa-pub');
        setup.sockets[0].triggerOpen();
        setup.sockets[0].triggerMessage({
            type: 'welcome',
            sessionCredential: 'cred',
            sessions: [],
        });
        return setup;
    }

    it('dispatches per-chat payload to all message handlers', () => {
        const { client, sockets } = connectedClient();
        const handler = vi.fn();
        client.onMessage(handler);
        sockets[0].triggerMessage({
            type: 'message',
            sessionId: 'chat-a',
            seq: 1,
            payload: { type: 'system', session_id: 'x' },
        });
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith('chat-a', { type: 'system', session_id: 'x' }, 1);
    });

    it('tracks lastSeq per chat session independently', () => {
        const { client, sockets, storage } = connectedClient();
        sockets[0].triggerMessage({ type: 'message', sessionId: 'chat-a', seq: 5, payload: {} });
        sockets[0].triggerMessage({ type: 'message', sessionId: 'chat-b', seq: 2, payload: {} });
        expect(client.getLastSeq('chat-a')).toBe(5);
        expect(client.getLastSeq('chat-b')).toBe(2);
        expect(client.getLastSeq('chat-c')).toBe(-1);
        expect(storage.loadCredentials()?.lastSeqs).toEqual({ 'chat-a': 5, 'chat-b': 2 });
    });

    it('does not regress lastSeq on out-of-order older messages', () => {
        const { client, sockets } = connectedClient();
        sockets[0].triggerMessage({ type: 'message', sessionId: 'A', seq: 10, payload: {} });
        sockets[0].triggerMessage({ type: 'message', sessionId: 'A', seq: 3, payload: {} });
        expect(client.getLastSeq('A')).toBe(10);
    });

    it('applies sessions-changed notification to live list', () => {
        const { client, sockets } = connectedClient();
        sockets[0].triggerMessage({
            type: 'sessions',
            sessions: [
                { id: 'A', tool: 'claude', model: null, cwd: '/', createdAt: 0, currentSeq: 0 },
                { id: 'B', tool: 'gemini', model: 'm', cwd: '/', createdAt: 1, currentSeq: 0 },
            ],
        });
        expect(client.getSessions().map((s) => s.id)).toEqual(['A', 'B']);
    });

    it('replies to ping with pong', () => {
        const { sockets } = connectedClient();
        sockets[0].sent.length = 0;
        sockets[0].triggerMessage({ type: 'ping' });
        expect(sockets[0].lastSent).toEqual({ type: 'pong' });
    });

    it('ignores malformed JSON without throwing', () => {
        const { sockets } = connectedClient();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => sockets[0].triggerRawMessage('{ not json')).not.toThrow();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('unsubscribing stops a handler from firing', () => {
        const { client, sockets } = connectedClient();
        const handler = vi.fn();
        const unsub = client.onMessage(handler);
        sockets[0].triggerMessage({ type: 'message', sessionId: 'x', seq: 1, payload: {} });
        unsub();
        sockets[0].triggerMessage({ type: 'message', sessionId: 'x', seq: 2, payload: {} });
        expect(handler).toHaveBeenCalledOnce();
    });
});

describe('SessionClient: RPC', () => {
    function connectedClient() {
        const setup = makeClient();
        setup.client.connectFirstTime(qrPayload, 'wa-pub');
        setup.sockets[0].triggerOpen();
        setup.sockets[0].triggerMessage({
            type: 'welcome',
            sessionCredential: 'c',
            sessions: [],
        });
        return setup;
    }

    it('sends rpc frame and resolves on matching rpc-response', async () => {
        const { client, sockets } = connectedClient();
        const promise = client.rpc('req-1', 'doThing', { x: 1 });
        expect(sockets[0].lastSent).toEqual({
            type: 'rpc',
            id: 'req-1',
            method: 'doThing',
            params: { x: 1 },
        });
        sockets[0].triggerMessage({ type: 'rpc-response', id: 'req-1', result: { ok: true } });
        await expect(promise).resolves.toEqual({ result: { ok: true }, error: undefined });
    });

    it('resolves with error string when server returns error', async () => {
        const { client, sockets } = connectedClient();
        const promise = client.rpc('req-2', 'boom');
        sockets[0].triggerMessage({ type: 'rpc-response', id: 'req-2', error: 'denied' });
        await expect(promise).resolves.toEqual({ result: undefined, error: 'denied' });
    });

    it('rejects on timeout', async () => {
        vi.useFakeTimers();
        try {
            const { client } = makeClient({ rpcTimeoutMs: 50 });
            client.connectFirstTime(qrPayload, 'wa-pub');
            FakeWebSocket.instances[0].triggerOpen();
            FakeWebSocket.instances[0].triggerMessage({
                type: 'welcome',
                sessionCredential: 'c',
                sessions: [],
            });
            const promise = client.rpc('req-3', 'slow');
            vi.advanceTimersByTime(51);
            await expect(promise).rejects.toThrow(/RPC timeout: slow/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores rpc-response with unknown id', async () => {
        const { sockets } = connectedClient();
        expect(() =>
            sockets[0].triggerMessage({ type: 'rpc-response', id: 'nobody', result: 1 })
        ).not.toThrow();
    });
});

describe('SessionClient: error paths', () => {
    it('transitions to error and closes connection on server error frame', () => {
        const { client, sockets } = makeClient();
        client.connectFirstTime(qrPayload, 'wa-pub');
        sockets[0].triggerOpen();
        sockets[0].triggerMessage({ type: 'error', message: 'auth failed' });
        expect(client.getStatus()).toBe('error');
        expect(client.getLastError()).toBe('auth failed');
    });

    it('detects mixed-content misconfiguration on socket error', () => {
        const { client, sockets } = makeClient({ pageProtocol: 'https:' });
        client.connectFirstTime(qrPayload, 'wa-pub');
        sockets[0].triggerError();
        expect(client.getStatus()).toBe('error');
        expect(client.getLastError()).toMatch(/Mixed content/);
    });

    it('uses generic error reason when protocol is fine', () => {
        const { client, sockets } = makeClient({ pageProtocol: 'http:' });
        client.connectFirstTime(qrPayload, 'wa-pub');
        sockets[0].triggerError();
        expect(client.getLastError()).toMatch(/connection failed/i);
    });
});

describe('SessionClient: disconnect', () => {
    it('closes the socket and sets status to disconnected', () => {
        const { client, sockets } = makeClient();
        client.connectFirstTime(qrPayload, 'wa-pub');
        sockets[0].triggerOpen();
        sockets[0].triggerMessage({ type: 'welcome', sessionCredential: 'c', sessions: [] });
        client.disconnect();
        expect(client.getStatus()).toBe('disconnected');
    });

    it('does not auto-reconnect after explicit disconnect', () => {
        vi.useFakeTimers();
        try {
            const { client, sockets } = makeClient();
            client.connectFirstTime(qrPayload, 'wa-pub');
            sockets[0].triggerOpen();
            client.disconnect();
            vi.advanceTimersByTime(60_000);
            expect(FakeWebSocket.instances).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SessionClient: reconnect behavior', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('schedules reconnect after unexpected close with exponential backoff', () => {
        const { client, sockets } = makeClient();
        client.connectFirstTime(qrPayload, 'wa-pub');
        sockets[0].triggerOpen();
        sockets[0].triggerClose();
        expect(client.getStatus()).toBe('disconnected');

        vi.advanceTimersByTime(1_000);
        expect(FakeWebSocket.instances).toHaveLength(2);

        FakeWebSocket.instances[1].triggerClose();
        vi.advanceTimersByTime(1_999);
        expect(FakeWebSocket.instances).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(FakeWebSocket.instances).toHaveLength(3);
    });
});

describe('SessionClient: credential helpers', () => {
    it('loadStoredCredentials delegates to storage', () => {
        const { client } = makeClient({ creds: storedCreds });
        expect(client.loadStoredCredentials()).toEqual(storedCreds);
    });

    it('clearCredentials removes them from storage', () => {
        const { client, storage } = makeClient({ creds: storedCreds });
        client.clearCredentials();
        expect(storage.loadCredentials()).toBeNull();
    });

    it('importCredentials writes through to storage', () => {
        const { client, storage } = makeClient();
        client.importCredentials(storedCreds);
        expect(storage.loadCredentials()).toEqual(storedCreds);
    });

    it('getOrCreateWebappKey returns storage key', () => {
        const { client } = makeClient();
        expect(client.getOrCreateWebappKey()).toBe('wa-pub');
    });
});

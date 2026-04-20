import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionClient } from './client';
import { createMemoryStorage } from './storage';
import type { DirectQRPayload, SocketStatus, StoredCredentials } from '../types';

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

// Expose global constant required by `send()` implementation
(globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket = { OPEN: FakeWebSocket.OPEN };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const qrPayload: DirectQRPayload = {
    type: 'direct',
    endpoint: 'ws://localhost:9999',
    cliSignPublicKey: 'cli-pub',
    sessionId: 'sess-1',
    nonce: 'nonce-xyz',
    nonceExpiry: Number.MAX_SAFE_INTEGER,
};

const storedCreds: StoredCredentials = {
    endpoint: 'ws://localhost:9999',
    cliPublicKey: 'cli-pub',
    sessionId: 'sess-1',
    sessionCredential: 'sess-cred-123',
    lastSeq: 42,
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
        expect(client.getLastSeq()).toBe(-1);
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
            currentSeq: 7,
        });
        expect(client.getStatus()).toBe('connected');
        expect(client.getLastSeq()).toBe(7);
        expect(storage.loadCredentials()).toEqual({
            endpoint: 'ws://localhost:9999',
            cliPublicKey: 'cli-pub',
            sessionId: 'sess-1',
            sessionCredential: 'new-cred',
            lastSeq: 7,
            webappPublicKey: 'wa-pub',
        });
    });

    it('defaults lastSeq to -1 when welcome omits currentSeq', () => {
        const { client, sockets, storage } = makeClient();
        client.connectFirstTime(qrPayload, 'wa-pub');
        sockets[0].triggerOpen();
        sockets[0].triggerMessage({ type: 'welcome', sessionCredential: 'c' });
        expect(client.getLastSeq()).toBe(-1);
        expect(storage.loadCredentials()?.lastSeq).toBe(-1);
    });
});

describe('SessionClient: resume from stored', () => {
    it('sends hello with sessionCredential + stored lastSeq', () => {
        const { client, sockets } = makeClient();
        client.connectFromStored(storedCreds);
        sockets[0].triggerOpen();
        expect(sockets[0].lastSent).toEqual({
            type: 'hello',
            sessionCredential: 'sess-cred-123',
            webappPublicKey: 'wa-pub',
            lastSeq: 42,
        });
    });

    it('does not resave credentials on welcome when resuming', () => {
        const { client, sockets, storage } = makeClient({ creds: storedCreds });
        const saveSpy = vi.spyOn(storage, 'saveCredentials');
        client.connectFromStored(storedCreds);
        sockets[0].triggerOpen();
        sockets[0].triggerMessage({ type: 'welcome' });
        expect(saveSpy).not.toHaveBeenCalled();
        expect(client.getStatus()).toBe('connected');
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
            currentSeq: 0,
        });
        return setup;
    }

    it('dispatches payload to all message handlers', () => {
        const { client, sockets } = connectedClient();
        const handler = vi.fn();
        client.onMessage(handler);
        sockets[0].triggerMessage({ type: 'message', seq: 1, payload: { type: 'system', session_id: 'x' } });
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith({ type: 'system', session_id: 'x' }, 1);
    });

    it('updates lastSeq monotonically and persists it', () => {
        const { client, sockets, storage } = connectedClient();
        sockets[0].triggerMessage({ type: 'message', seq: 5, payload: {} });
        expect(client.getLastSeq()).toBe(5);
        expect(storage.loadCredentials()?.lastSeq).toBe(5);
    });

    it('does not regress lastSeq on out-of-order older messages', () => {
        const { client, sockets } = connectedClient();
        sockets[0].triggerMessage({ type: 'message', seq: 10, payload: {} });
        sockets[0].triggerMessage({ type: 'message', seq: 3, payload: {} });
        expect(client.getLastSeq()).toBe(10);
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
        sockets[0].triggerMessage({ type: 'message', seq: 1, payload: {} });
        unsub();
        sockets[0].triggerMessage({ type: 'message', seq: 2, payload: {} });
        expect(handler).toHaveBeenCalledOnce();
    });
});

describe('SessionClient: RPC', () => {
    function connectedClient() {
        const setup = makeClient();
        setup.client.connectFirstTime(qrPayload, 'wa-pub');
        setup.sockets[0].triggerOpen();
        setup.sockets[0].triggerMessage({ type: 'welcome', sessionCredential: 'c' });
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
            FakeWebSocket.instances[0].triggerMessage({ type: 'welcome', sessionCredential: 'c' });
            const promise = client.rpc('req-3', 'slow');
            vi.advanceTimersByTime(51);
            await expect(promise).rejects.toThrow(/RPC timeout: slow/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores rpc-response with unknown id', async () => {
        const { sockets } = connectedClient();
        // Should not throw even though no pending entry exists
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
        sockets[0].triggerMessage({ type: 'welcome', sessionCredential: 'c' });
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

        // First retry fires after initial delay (1000ms)
        vi.advanceTimersByTime(1_000);
        expect(FakeWebSocket.instances).toHaveLength(2);

        // Close again — next retry should be 2× the previous delay
        FakeWebSocket.instances[1].triggerClose();
        vi.advanceTimersByTime(1_999);
        expect(FakeWebSocket.instances).toHaveLength(2); // not yet
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

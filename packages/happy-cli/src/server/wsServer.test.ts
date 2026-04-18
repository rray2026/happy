import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateCliKeys, buildQRPayload, issueCredential } from './directAuth';
import { startWsServer } from './wsServer';
import type { WsServerHandle, CliMessage, DirectQRPayload, CliKeys } from './types';

// ── port allocator (avoids inter-test conflicts) ──────────────────────────────

let _nextPort = 19_000;
function allocPort(): number { return _nextPort++; }

// ── test fixtures ─────────────────────────────────────────────────────────────

interface TestOpts {
    port: number;
    sessionId: string;
    cliKeys: CliKeys;
    qrPayload: DirectQRPayload;
    onRpc: (id: string, method: string, params: unknown) => Promise<void>;
    onInput: (text: string) => void;
}

function makeOpts(overrides?: Partial<TestOpts>): TestOpts {
    const port = overrides?.port ?? allocPort();
    const sessionId = overrides?.sessionId ?? randomUUID();
    const cliKeys = overrides?.cliKeys ?? generateCliKeys();
    const qrPayload = overrides?.qrPayload ?? buildQRPayload('ws://localhost', cliKeys, sessionId);
    return {
        port,
        sessionId,
        cliKeys,
        qrPayload,
        onRpc: overrides?.onRpc ?? (() => Promise.resolve()),
        onInput: overrides?.onInput ?? (() => {}),
    };
}

// ── message collector ─────────────────────────────────────────────────────────
// A buffering message queue that prevents missed-event races. Register the
// listener before sending hello so that welcome and any delta messages queued
// by the server in the same synchronous turn are never dropped.

interface MessageCollector {
    next(timeoutMs?: number): Promise<CliMessage>;
    close(): void;
}

function createCollector(ws: WebSocket): MessageCollector {
    const queue: CliMessage[] = [];
    const waiters: Array<{ resolve: (m: CliMessage) => void; timer: ReturnType<typeof setTimeout> }> = [];

    const handler = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data as string) as CliMessage;
        if (waiters.length > 0) {
            const { resolve, timer } = waiters.shift()!;
            clearTimeout(timer);
            resolve(msg);
        } else {
            queue.push(msg);
        }
    };

    ws.addEventListener('message', handler);

    return {
        next(timeoutMs = 2000): Promise<CliMessage> {
            if (queue.length > 0) return Promise.resolve(queue.shift()!);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error('timeout waiting for ws message')),
                    timeoutMs,
                );
                waiters.push({ resolve, timer });
            });
        },
        close(): void {
            ws.removeEventListener('message', handler);
        },
    };
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

interface TestClient {
    ws: WebSocket;
    collector: MessageCollector;
}

function waitOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('ws open error')), { once: true });
    });
}

function waitClose(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
        ws.addEventListener('close', () => resolve(), { once: true });
    });
}

async function firstTimeHandshake(
    { ws, collector }: TestClient,
    qrPayload: DirectQRPayload,
    webappPublicKey = 'webapp-key-test',
): Promise<CliMessage> {
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', nonce: qrPayload.nonce, webappPublicKey }));
    return collector.next();
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('wsServer', () => {
    const handles: WsServerHandle[] = [];
    const clients: TestClient[] = [];

    afterEach(async () => {
        for (const { ws, collector } of clients) {
            collector.close();
            if (ws.readyState !== WebSocket.CLOSED) ws.close();
        }
        clients.length = 0;
        for (const h of handles) h.close();
        handles.length = 0;
        await new Promise((r) => setTimeout(r, 30));
    });

    function start(opts: TestOpts): WsServerHandle {
        const h = startWsServer(opts);
        handles.push(h);
        return h;
    }

    function client(port: number): TestClient {
        const ws = new WebSocket(`ws://0.0.0.0:${port}`);
        const collector = createCollector(ws);
        const tc: TestClient = { ws, collector };
        clients.push(tc);
        return tc;
    }

    // ── first-time handshake ──────────────────────────────────────────────────

    describe('first-time handshake', () => {
        it('sends welcome with correct sessionId after a valid nonce', async () => {
            const opts = makeOpts();
            start(opts);
            const tc = client(opts.port);

            const msg = await firstTimeHandshake(tc, opts.qrPayload);

            expect(msg.type).toBe('welcome');
            if (msg.type === 'welcome') {
                expect(msg.sessionId).toBe(opts.sessionId);
                expect(typeof msg.sessionCredential).toBe('string');
                expect(msg.currentSeq).toBe(-1);
            }
        });

        it('replies with error and closes when nonce does not match', async () => {
            const opts = makeOpts();
            start(opts);
            const { ws, collector } = client(opts.port);
            await waitOpen(ws);
            ws.send(JSON.stringify({ type: 'hello', nonce: 'wrong-nonce', webappPublicKey: 'key' }));

            const msg = await collector.next();
            expect(msg.type).toBe('error');
            await waitClose(ws);
        });

        it('replies with error and closes when nonce is expired', async () => {
            const cliKeys = generateCliKeys();
            const sessionId = randomUUID();
            const qrPayload: DirectQRPayload = {
                type: 'direct',
                endpoint: 'ws://localhost',
                cliSignPublicKey: 'key',
                sessionId,
                nonce: 'the-nonce',
                nonceExpiry: Date.now() - 1,
            };
            const opts = makeOpts({ cliKeys, sessionId, qrPayload });
            start(opts);
            const { ws, collector } = client(opts.port);
            await waitOpen(ws);
            ws.send(JSON.stringify({ type: 'hello', nonce: 'the-nonce', webappPublicKey: 'key' }));

            const msg = await collector.next();
            expect(msg.type).toBe('error');
            await waitClose(ws);
        });

        it('sends delta messages that were broadcast before the client connected', async () => {
            const opts = makeOpts();
            const h = start(opts);
            h.broadcast({ text: 'early-message' }); // seq 0

            const tc = client(opts.port);
            const welcome = await firstTimeHandshake(tc, opts.qrPayload);
            expect(welcome.type).toBe('welcome');
            if (welcome.type === 'welcome') expect(welcome.currentSeq).toBe(0);

            // Delta is sent right after welcome in completeHandshake
            const delta = await tc.collector.next();
            expect(delta.type).toBe('message');
            if (delta.type === 'message') {
                expect(delta.seq).toBe(0);
                expect((delta.payload as { text: string }).text).toBe('early-message');
            }
        });
    });

    // ── reconnect handshake ───────────────────────────────────────────────────

    describe('reconnect handshake', () => {
        it('accepts a valid credential issued during a prior session', async () => {
            const opts = makeOpts();
            start(opts);

            // First connection: obtain a credential
            const tc1 = client(opts.port);
            const welcome1 = await firstTimeHandshake(tc1, opts.qrPayload);
            expect(welcome1.type).toBe('welcome');
            const credential = (welcome1 as { type: 'welcome'; sessionCredential: string }).sessionCredential;
            tc1.ws.close();
            await waitClose(tc1.ws);

            // Second connection: reconnect with the credential
            const tc2 = client(opts.port);
            await waitOpen(tc2.ws);
            tc2.ws.send(JSON.stringify({
                type: 'hello',
                sessionCredential: credential,
                webappPublicKey: 'webapp-key-test',
                lastSeq: -1,
            }));
            const welcome2 = await tc2.collector.next();
            expect(welcome2.type).toBe('welcome');
        });

        it('replies with error when credential is tampered', async () => {
            const opts = makeOpts();
            start(opts);
            const { ws, collector } = client(opts.port);
            await waitOpen(ws);
            ws.send(JSON.stringify({
                type: 'hello',
                sessionCredential: '{"payload":"{}","signature":"AAAA"}',
                webappPublicKey: 'key',
                lastSeq: -1,
            }));

            const msg = await collector.next();
            expect(msg.type).toBe('error');
            await waitClose(ws);
        });

        it('replies with error when credential has a wrong sessionId', async () => {
            const opts = makeOpts();
            start(opts);

            const wrongCredential = issueCredential('webapp-key', randomUUID(), opts.cliKeys.signSecretKey);

            const { ws, collector } = client(opts.port);
            await waitOpen(ws);
            ws.send(JSON.stringify({
                type: 'hello',
                sessionCredential: wrongCredential,
                webappPublicKey: 'webapp-key',
                lastSeq: -1,
            }));

            const msg = await collector.next();
            expect(msg.type).toBe('error');
            await waitClose(ws);
        });

        it('sends only the delta from lastSeq+1 onward', async () => {
            const opts = makeOpts();
            const h = start(opts);
            h.broadcast('msg-0'); // seq 0
            h.broadcast('msg-1'); // seq 1
            h.broadcast('msg-2'); // seq 2

            const credential = issueCredential('webapp-key', opts.sessionId, opts.cliKeys.signSecretKey);

            const tc = client(opts.port);
            await waitOpen(tc.ws);
            tc.ws.send(JSON.stringify({
                type: 'hello',
                sessionCredential: credential,
                webappPublicKey: 'webapp-key',
                lastSeq: 0, // client already has seq 0
            }));

            const welcome = await tc.collector.next();
            expect(welcome.type).toBe('welcome');

            // Should receive seq 1 and 2 only
            const d1 = await tc.collector.next();
            const d2 = await tc.collector.next();
            if (d1.type === 'message') expect(d1.seq).toBe(1);
            if (d2.type === 'message') expect(d2.seq).toBe(2);
        });
    });

    // ── broadcast ─────────────────────────────────────────────────────────────

    describe('broadcast', () => {
        it('pushes new messages to the connected client', async () => {
            const opts = makeOpts();
            const h = start(opts);
            const tc = client(opts.port);
            await firstTimeHandshake(tc, opts.qrPayload);

            h.broadcast({ event: 'assistant', text: 'hello world' });
            const msg = await tc.collector.next();
            expect(msg.type).toBe('message');
            if (msg.type === 'message') {
                expect(msg.seq).toBe(0);
                expect((msg.payload as { text: string }).text).toBe('hello world');
            }
        });

        it('returns incrementing seq numbers', () => {
            const opts = makeOpts();
            const h = start(opts);
            expect(h.broadcast('a')).toBe(0);
            expect(h.broadcast('b')).toBe(1);
            expect(h.broadcast('c')).toBe(2);
        });
    });

    // ── input dispatch ────────────────────────────────────────────────────────

    describe('input dispatch', () => {
        it('calls onInput with the text sent by the webapp', async () => {
            const received: string[] = [];
            const opts = makeOpts({ onInput: (text) => received.push(text) });
            start(opts);
            const tc = client(opts.port);
            await firstTimeHandshake(tc, opts.qrPayload);

            tc.ws.send(JSON.stringify({ type: 'input', text: 'run the tests' }));
            await new Promise((r) => setTimeout(r, 100));
            expect(received).toEqual(['run the tests']);
        });
    });

    // ── rpc dispatch ──────────────────────────────────────────────────────────

    describe('rpc dispatch', () => {
        it('calls onRpc with id, method, and params', async () => {
            const calls: Array<{ id: string; method: string; params: unknown }> = [];
            const opts = makeOpts({
                onRpc: async (id, method, params) => { calls.push({ id, method, params }); },
            });
            start(opts);
            const tc = client(opts.port);
            await firstTimeHandshake(tc, opts.qrPayload);

            tc.ws.send(JSON.stringify({ type: 'rpc', id: 'call-1', method: 'approve', params: { allow: true } }));
            await new Promise((r) => setTimeout(r, 100));
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({ id: 'call-1', method: 'approve', params: { allow: true } });
        });
    });

    // ── sendRpcResponse ───────────────────────────────────────────────────────

    describe('sendRpcResponse', () => {
        it('delivers rpc-response with result to the client', async () => {
            const opts = makeOpts();
            const h = start(opts);
            const tc = client(opts.port);
            await firstTimeHandshake(tc, opts.qrPayload);

            h.sendRpcResponse('call-42', { granted: true });
            const msg = await tc.collector.next();
            expect(msg.type).toBe('rpc-response');
            if (msg.type === 'rpc-response') {
                expect(msg.id).toBe('call-42');
                expect((msg.result as { granted: boolean }).granted).toBe(true);
            }
        });

        it('delivers rpc-response with error string to the client', async () => {
            const opts = makeOpts();
            const h = start(opts);
            const tc = client(opts.port);
            await firstTimeHandshake(tc, opts.qrPayload);

            h.sendRpcResponse('call-99', null, 'permission denied');
            const msg = await tc.collector.next();
            expect(msg.type).toBe('rpc-response');
            if (msg.type === 'rpc-response') {
                expect(msg.id).toBe('call-99');
                expect(msg.error).toBe('permission denied');
            }
        });
    });

    // ── client eviction ───────────────────────────────────────────────────────

    describe('client eviction', () => {
        it('closes the previous client when a new connection arrives', async () => {
            const opts = makeOpts();
            start(opts);

            const tc1 = client(opts.port);
            await firstTimeHandshake(tc1, opts.qrPayload);

            // Second client connecting triggers eviction of tc1.ws
            const tc2 = client(opts.port);
            await Promise.all([waitClose(tc1.ws), waitOpen(tc2.ws)]);
            expect(tc1.ws.readyState).toBe(WebSocket.CLOSED);
        });
    });

    // ── malformed messages ────────────────────────────────────────────────────

    describe('malformed messages', () => {
        it('replies with error and closes on non-JSON input', async () => {
            const opts = makeOpts();
            start(opts);
            const { ws, collector } = client(opts.port);
            await waitOpen(ws);
            ws.send('this is not json');

            const msg = await collector.next();
            expect(msg.type).toBe('error');
            await waitClose(ws);
        });
    });
});

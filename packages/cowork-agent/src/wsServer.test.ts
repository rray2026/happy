import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildQRPayload, generateCliKeys } from './auth.js';
import { encodeBase64 } from './encoding.js';
import type { SessionMeta } from './sessionManager.js';
import type { CliMessage, WsServerHandle } from './types.js';
import { startWsServer } from './wsServer.js';

interface TestRig {
    port: number;
    sessionId: string;
    cliKeys: ReturnType<typeof generateCliKeys>;
    qrPayload: ReturnType<typeof buildQRPayload>;
    server: WsServerHandle;
    inputs: Array<{ sessionId: string; text: string }>;
    rpcCalls: Array<{ id: string; method: string; params: unknown }>;
    sessions: SessionMeta[];
    replays: Map<string, Array<{ seq: number; payload: unknown }>>;
}

async function spin(
    sessions: SessionMeta[] = [],
    replays: Map<string, Array<{ seq: number; payload: unknown }>> = new Map(),
): Promise<TestRig> {
    const cliKeys = generateCliKeys();
    const sessionId = cliKeys.sessionId;
    const inputs: Array<{ sessionId: string; text: string }> = [];
    const rpcCalls: Array<{ id: string; method: string; params: unknown }> = [];
    const qrPayload = buildQRPayload('ws://127.0.0.1:0', cliKeys, sessionId);

    const server = startWsServer({
        port: 0,
        host: '127.0.0.1',
        sessionId,
        cliKeys,
        qrPayload,
        listSessions: () => sessions,
        replayFrom: (sid, fromSeq) => {
            const entries = replays.get(sid) ?? [];
            return entries.filter((e) => e.seq > fromSeq);
        },
        onInput: (sid, text) => inputs.push({ sessionId: sid, text }),
        onRpc: async (id, method, params) => {
            rpcCalls.push({ id, method, params });
        },
    });

    await server.ready();
    return {
        port: server.port(),
        sessionId,
        cliKeys,
        qrPayload,
        server,
        inputs,
        rpcCalls,
        sessions,
        replays,
    };
}

function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<CliMessage> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no message within timeout')), timeoutMs);
        ws.once('message', (data) => {
            clearTimeout(t);
            resolve(JSON.parse(data.toString()) as CliMessage);
        });
    });
}

/** Buffering reader that never loses frames between awaits (unlike `once`).
 *  Returns a getter that awaits the next message in order. */
function makeReader(ws: WebSocket): {
    next: (timeoutMs?: number) => Promise<CliMessage>;
    drainCount: (n: number, timeoutMs?: number) => Promise<CliMessage[]>;
    dispose: () => void;
} {
    const queue: CliMessage[] = [];
    const waiters: Array<(msg: CliMessage) => void> = [];
    const handler = (data: unknown) => {
        const msg = JSON.parse(String(data)) as CliMessage;
        const w = waiters.shift();
        if (w) w(msg);
        else queue.push(msg);
    };
    ws.on('message', handler);

    const next = (timeoutMs = 1000): Promise<CliMessage> =>
        new Promise((resolve, reject) => {
            if (queue.length > 0) return resolve(queue.shift()!);
            const t = setTimeout(() => {
                const idx = waiters.indexOf(resolver);
                if (idx >= 0) waiters.splice(idx, 1);
                reject(new Error('no message within timeout'));
            }, timeoutMs);
            const resolver = (msg: CliMessage) => {
                clearTimeout(t);
                resolve(msg);
            };
            waiters.push(resolver);
        });

    return {
        next,
        async drainCount(n, timeoutMs = 2000) {
            const out: CliMessage[] = [];
            for (let i = 0; i < n; i++) out.push(await next(timeoutMs));
            return out;
        },
        dispose: () => ws.off('message', handler),
    };
}

function waitClose(ws: WebSocket, timeoutMs = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no close within timeout')), timeoutMs);
        ws.once('close', () => {
            clearTimeout(t);
            resolve();
        });
    });
}

describe('wsServer — two-phase protocol', () => {
    let rig: TestRig;

    beforeEach(async () => {
        rig = await spin();
    });

    afterEach(() => {
        rig.server.close();
    });

    it('accepts first-time hello and issues credential + empty session list', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        const welcome = await nextMessage(ws);
        expect(welcome.type).toBe('welcome');
        if (welcome.type === 'welcome') {
            expect(welcome.sessionId).toBe(rig.sessionId);
            expect(welcome.sessionCredential).toBeTypeOf('string');
            expect(welcome.sessions).toEqual([]);
            expect(JSON.parse(welcome.sessionCredential)).toHaveProperty('signature');
        }
        ws.close();
    });

    it('welcome snapshot includes currently live sessions', async () => {
        const meta: SessionMeta = {
            id: 'sess-1',
            tool: 'claude',
            model: undefined,
            cwd: '/tmp',
            createdAt: 123,
            currentSeq: -1,
        };
        rig.server.close();
        rig = await spin([meta]);

        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        const welcome = await nextMessage(ws);
        expect(welcome.type).toBe('welcome');
        if (welcome.type === 'welcome') expect(welcome.sessions).toEqual([meta]);
        ws.close();
    });

    it('rejects input sent before hello (auth bypass closed)', async () => {
        const ws = await connect(rig.port);
        ws.send(JSON.stringify({ type: 'input', sessionId: 'x', text: 'attack' }));
        const msg = await nextMessage(ws);
        expect(msg.type).toBe('error');
        if (msg.type === 'error') expect(msg.message).toBe('expected hello message');
        await waitClose(ws);
        expect(rig.inputs).toEqual([]);
    });

    it('rejects rpc sent before hello', async () => {
        const ws = await connect(rig.port);
        ws.send(JSON.stringify({ type: 'rpc', id: 'x', method: 'session.list', params: {} }));
        const msg = await nextMessage(ws);
        expect(msg.type).toBe('error');
        await waitClose(ws);
        expect(rig.rpcCalls).toEqual([]);
    });

    it('rejects pong sent before hello', async () => {
        const ws = await connect(rig.port);
        ws.send(JSON.stringify({ type: 'pong' }));
        const msg = await nextMessage(ws);
        expect(msg.type).toBe('error');
        await waitClose(ws);
    });

    it('rejects second hello after handshake complete', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        await nextMessage(ws); // welcome

        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: 'whatever',
                webappPublicKey: 'webapp-pub',
            }),
        );
        const msg = await nextMessage(ws);
        expect(msg.type).toBe('error');
        if (msg.type === 'error') expect(msg.message).toBe('invalid session message');
        await waitClose(ws);
    });

    it('nonce is one-time: second first-time handshake is rejected', async () => {
        const ws1 = await connect(rig.port);
        ws1.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        await nextMessage(ws1);
        ws1.close();

        const ws2 = await connect(rig.port);
        ws2.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        const msg = await nextMessage(ws2);
        expect(msg.type).toBe('error');
        if (msg.type === 'error') expect(msg.message).toBe('nonce expired or invalid');
    });

    it('rejects malformed JSON with error + close', async () => {
        const ws = await connect(rig.port);
        ws.send('not json at all');
        const msg = await nextMessage(ws);
        expect(msg.type).toBe('error');
        if (msg.type === 'error') expect(msg.message).toBe('invalid JSON');
        await waitClose(ws);
    });

    it('rejects hello with injected extra fields (strict schema)', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
                injected: 'bad',
            }),
        );
        const msg = await nextMessage(ws);
        expect(msg.type).toBe('error');
        if (msg.type === 'error') expect(msg.message).toBe('expected hello message');
        await waitClose(ws);
    });

    it('after handshake: pushMessage reaches the client with sessionId + seq', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        await nextMessage(ws); // welcome

        rig.server.pushMessage('sess-a', 7, { hello: 'world' });
        const got = await nextMessage(ws);
        expect(got.type).toBe('message');
        if (got.type === 'message') {
            expect(got.sessionId).toBe('sess-a');
            expect(got.seq).toBe(7);
            expect(got.payload).toEqual({ hello: 'world' });
        }
        ws.close();
    });

    it('after handshake: input is delivered to onInput with sessionId', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        await nextMessage(ws); // welcome

        ws.send(JSON.stringify({ type: 'input', sessionId: 'sess-42', text: 'hello agent' }));
        await new Promise((r) => setTimeout(r, 10));
        expect(rig.inputs).toEqual([{ sessionId: 'sess-42', text: 'hello agent' }]);
        ws.close();
    });

    it('reconnect with lastSeqs replays only newer events per session', async () => {
        const sessionA: SessionMeta = {
            id: 'A',
            tool: 'claude',
            model: undefined,
            cwd: '/tmp',
            createdAt: 1,
            currentSeq: 2,
        };
        const sessionB: SessionMeta = {
            id: 'B',
            tool: 'gemini',
            model: 'gemini-2.5',
            cwd: '/tmp',
            createdAt: 2,
            currentSeq: 1,
        };
        const replays = new Map<string, Array<{ seq: number; payload: unknown }>>();
        replays.set('A', [
            { seq: 0, payload: 'a0' },
            { seq: 1, payload: 'a1' },
            { seq: 2, payload: 'a2' },
        ]);
        replays.set('B', [
            { seq: 0, payload: 'b0' },
            { seq: 1, payload: 'b1' },
        ]);
        rig.server.close();
        rig = await spin([sessionA, sessionB], replays);

        // First-time hello → get a credential, drain replays, then close.
        const ws1 = await connect(rig.port);
        const reader1 = makeReader(ws1);
        ws1.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        const welcome1 = await reader1.next();
        expect(welcome1.type).toBe('welcome');
        // Drain all replays from first handshake (A has 3, B has 2 ⇒ 5 messages).
        await reader1.drainCount(5);
        const credential = welcome1.type === 'welcome' ? welcome1.sessionCredential : '';
        reader1.dispose();
        ws1.close();
        await new Promise((r) => setTimeout(r, 10));

        // Reconnect claiming we've already seen A up to seq=1, nothing of B.
        const ws2 = await connect(rig.port);
        const reader2 = makeReader(ws2);
        ws2.send(
            JSON.stringify({
                type: 'hello',
                sessionCredential: credential,
                webappPublicKey: 'webapp-pub',
                lastSeqs: { A: 1 },
            }),
        );
        await reader2.next(); // welcome

        const got = await reader2.drainCount(3);
        const synced = got.filter((m) => m.type === 'message');
        expect(synced).toHaveLength(3);
        expect(synced[0]).toMatchObject({ type: 'message', sessionId: 'A', seq: 2 });
        expect(synced[1]).toMatchObject({ type: 'message', sessionId: 'B', seq: 0 });
        expect(synced[2]).toMatchObject({ type: 'message', sessionId: 'B', seq: 1 });
        reader2.dispose();
        ws2.close();
    });

    it('rejects reconnect with invalid credential signature', async () => {
        const ws = await connect(rig.port);
        const otherKeys = generateCliKeys();
        const badCred = JSON.stringify({
            payload: JSON.stringify({
                webappPublicKey: 'pk',
                sessionId: rig.sessionId,
                expiry: Date.now() + 60_000,
            }),
            signature: encodeBase64(otherKeys.signSecretKey.slice(0, 64)),
        });
        ws.send(
            JSON.stringify({
                type: 'hello',
                sessionCredential: badCred,
                webappPublicKey: 'pk',
                lastSeqs: {},
            }),
        );
        const msg = await nextMessage(ws);
        expect(msg.type).toBe('error');
        if (msg.type === 'error') expect(msg.message).toBe('invalid credential');
        await waitClose(ws);
    });

    it('uses sessionId from randomUUID (sanity)', () => {
        expect(rig.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });
});

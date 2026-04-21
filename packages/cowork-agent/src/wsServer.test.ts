import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildQRPayload, generateCliKeys } from './auth.js';
import { encodeBase64 } from './encoding.js';
import { startWsServer } from './wsServer.js';
import type { CliMessage, WsServerHandle } from './types.js';

interface TestRig {
    port: number;
    sessionId: string;
    cliKeys: ReturnType<typeof generateCliKeys>;
    qrPayload: ReturnType<typeof buildQRPayload>;
    server: WsServerHandle;
    inputs: string[];
    rpcCalls: Array<{ id: string; method: string; params: unknown }>;
}

async function spin(): Promise<TestRig> {
    const cliKeys = generateCliKeys();
    const sessionId = cliKeys.sessionId;
    const inputs: string[] = [];
    const rpcCalls: Array<{ id: string; method: string; params: unknown }> = [];
    // Endpoint is cosmetic for tests — server only verifies nonce/expiry.
    const qrPayload = buildQRPayload('ws://127.0.0.1:0', cliKeys, sessionId);

    const server = startWsServer({
        port: 0, // OS-assigned; avoids races on hard-coded ports under test load
        host: '127.0.0.1',
        sessionId,
        cliKeys,
        qrPayload,
        onInput: (text) => inputs.push(text),
        onRpc: async (id, method, params) => {
            rpcCalls.push({ id, method, params });
        },
    });

    await server.ready();
    return { port: server.port(), sessionId, cliKeys, qrPayload, server, inputs, rpcCalls };
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

    it('accepts valid first-time hello and issues credential', async () => {
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
            expect(JSON.parse(welcome.sessionCredential)).toHaveProperty('signature');
        }
        ws.close();
    });

    it('rejects input sent before hello (auth bypass closed)', async () => {
        const ws = await connect(rig.port);
        ws.send(JSON.stringify({ type: 'input', text: 'attack' }));
        const msg = await nextMessage(ws);
        expect(msg.type).toBe('error');
        if (msg.type === 'error') expect(msg.message).toBe('expected hello message');
        await waitClose(ws);
        expect(rig.inputs).toEqual([]);
    });

    it('rejects rpc sent before hello', async () => {
        const ws = await connect(rig.port);
        ws.send(JSON.stringify({ type: 'rpc', id: 'x', method: 'abort', params: {} }));
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
        await nextMessage(ws1); // welcome
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

    it('after handshake: broadcasts reach the client', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        await nextMessage(ws); // welcome

        rig.server.broadcast({ hello: 'world' });
        const got = await nextMessage(ws);
        expect(got.type).toBe('message');
        if (got.type === 'message') {
            expect(got.seq).toBe(0);
            expect(got.payload).toEqual({ hello: 'world' });
        }
        ws.close();
    });

    it('after handshake: input is delivered to onInput', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        await nextMessage(ws);

        ws.send(JSON.stringify({ type: 'input', text: 'hello agent' }));
        // consume the user-event echo
        await nextMessage(ws);
        // give event loop a tick to deliver
        await new Promise((r) => setTimeout(r, 10));
        expect(rig.inputs).toEqual(['hello agent']);
        ws.close();
    });

    it('after handshake: user input is recorded with seq and echoed back', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        await nextMessage(ws); // welcome

        ws.send(JSON.stringify({ type: 'input', text: 'hi there' }));
        const echo = await nextMessage(ws);
        expect(echo.type).toBe('message');
        if (echo.type === 'message') {
            expect(echo.seq).toBe(0);
            expect(echo.payload).toEqual({
                type: 'user',
                message: { role: 'user', content: 'hi there' },
            });
        }
        ws.close();
    });

    it('user input and agent broadcasts share one monotonically increasing seq space', async () => {
        const ws = await connect(rig.port);
        ws.send(
            JSON.stringify({
                type: 'hello',
                nonce: rig.qrPayload.nonce,
                webappPublicKey: 'webapp-pub',
            }),
        );
        await nextMessage(ws); // welcome

        // user input → seq 0
        ws.send(JSON.stringify({ type: 'input', text: 'first' }));
        const m0 = await nextMessage(ws);
        // agent broadcast → seq 1
        rig.server.broadcast({ type: 'assistant', text: 'reply' });
        const m1 = await nextMessage(ws);
        // another user input → seq 2
        ws.send(JSON.stringify({ type: 'input', text: 'second' }));
        const m2 = await nextMessage(ws);

        if (m0.type === 'message') expect(m0.seq).toBe(0);
        if (m1.type === 'message') expect(m1.seq).toBe(1);
        if (m2.type === 'message') expect(m2.seq).toBe(2);
        ws.close();
    });

    it('rejects reconnect with invalid credential signature', async () => {
        const ws = await connect(rig.port);
        const otherKeys = generateCliKeys();
        // forge a credential signed by different keys
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
                lastSeq: 0,
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

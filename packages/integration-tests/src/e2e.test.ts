import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredCredentials } from '../../cowork-webapp/src/types';
import { startRig, waitFor, waitForStatus, type E2ERig } from './harness';

describe('E2E: webapp SessionClient ↔ agent WebSocket server', () => {
    let rig: E2ERig;

    beforeEach(async () => {
        rig = await startRig();
    });
    afterEach(async () => {
        await rig.dispose();
    });

    // ── Handshake ─────────────────────────────────────────────────────────────

    it('first-time handshake: client connects, agent issues credential, storage persists it', async () => {
        const { client, storage } = rig.makeClient();
        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');

        const saved = storage.loadCredentials();
        expect(saved).not.toBeNull();
        expect(saved?.endpoint).toBe(rig.endpoint);
        expect(saved?.sessionId).toBe(rig.sessionId);
        expect(saved?.webappPublicKey).toBe('wa-pub');
        // credential is a JSON string containing { payload, signature }
        expect(saved?.sessionCredential).toMatch(/"signature"/);
        expect(client.getLastSeq()).toBe(-1); // no messages yet

        client.disconnect();
    });

    it('nonce is one-time: second first-time handshake with same QR is rejected', async () => {
        const first = rig.makeClient();
        first.client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(first.client, 'connected');
        first.client.disconnect();

        const second = rig.makeClient();
        second.client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(second.client, 'error');
        expect(second.client.getLastError()).toBe('nonce expired or invalid');
    });

    // ── User input recording (the IM-style behavior) ──────────────────────────

    it('user input round-trip: client sendInput → agent records + echoes → client sees user-event at seq=0', async () => {
        const { client } = rig.makeClient();
        const received: Array<{ payload: unknown; seq: number }> = [];
        client.onMessage((payload, seq) => received.push({ payload, seq }));

        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');

        client.sendInput('hello agent');

        await waitFor(() => received.length >= 1);
        expect(rig.inputs).toEqual(['hello agent']);
        expect(received[0]).toEqual({
            seq: 0,
            payload: { type: 'user', message: { role: 'user', content: 'hello agent' } },
        });
        expect(client.getLastSeq()).toBe(0);

        client.disconnect();
    });

    it('seq space is unified: user input and agent broadcasts increment the same counter', async () => {
        const { client } = rig.makeClient();
        const received: Array<{ payload: unknown; seq: number }> = [];
        client.onMessage((payload, seq) => received.push({ payload, seq }));

        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');

        client.sendInput('first'); // seq 0
        await waitFor(() => received.length >= 1);

        rig.server.broadcast({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }); // seq 1
        await waitFor(() => received.length >= 2);

        client.sendInput('second'); // seq 2
        await waitFor(() => received.length >= 3);

        expect(received.map((r) => r.seq)).toEqual([0, 1, 2]);
        expect(received[0].payload).toMatchObject({ type: 'user' });
        expect(received[1].payload).toMatchObject({ type: 'assistant' });
        expect(received[2].payload).toMatchObject({ type: 'user' });
        expect(client.getLastSeq()).toBe(2);

        client.disconnect();
    });

    // ── Reconnect & delta replay ──────────────────────────────────────────────

    it('reconnect delta: client receives only missing messages after disconnect', async () => {
        const { client, storage } = rig.makeClient();
        const received: number[] = [];
        client.onMessage((_p, seq) => received.push(seq));

        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');

        client.sendInput('live'); // seq 0
        await waitFor(() => received.length >= 1);

        // Disconnect; save the creds the client persisted.
        const saved = storage.loadCredentials();
        expect(saved).not.toBeNull();
        client.disconnect();

        // Agent produces more events while the client is offline.
        rig.server.broadcast({ type: 'tool_use', id: 'x', name: 'Read' }); // seq 1
        rig.server.broadcast({ type: 'assistant', text: 'done' }); // seq 2

        // New client reconnects from stored credentials.
        const resumed = rig.makeClient(saved);
        const replayed: number[] = [];
        resumed.client.onMessage((_p, seq) => replayed.push(seq));
        resumed.client.connectFromStored(saved as StoredCredentials);
        await waitForStatus(resumed.client, 'connected');

        // Only the two messages emitted while offline should arrive — not seq 0.
        await waitFor(() => replayed.length >= 2);
        expect(replayed).toEqual([1, 2]);
        expect(resumed.client.getLastSeq()).toBe(2);

        resumed.client.disconnect();
    });

    it('reconnect with tampered credential is rejected', async () => {
        const { client, storage } = rig.makeClient();
        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');
        const saved = storage.loadCredentials()!;
        client.disconnect();

        // Corrupt the signature.
        const tampered: StoredCredentials = {
            ...saved,
            sessionCredential: saved.sessionCredential.replace(/"signature":"[^"]+"/, '"signature":"AAAA"'),
        };

        const bad = rig.makeClient(tampered);
        bad.client.connectFromStored(tampered);
        await waitForStatus(bad.client, 'error');
        expect(bad.client.getLastError()).toBe('invalid credential');
    });

    // ── RPC ────────────────────────────────────────────────────────────────────

    it('rpc round-trip: client.rpc() resolves with agent-side result', async () => {
        rig.setRpcResponder((id, method, params) => {
            if (method === 'echo') {
                rig.server.sendRpcResponse(id, { method, params });
            } else {
                rig.server.sendRpcResponse(id, null, `unknown method: ${method}`);
            }
        });

        const { client } = rig.makeClient();
        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');

        const res = await client.rpc('req-1', 'echo', { x: 42 });
        expect(res.error).toBeUndefined();
        expect(res.result).toEqual({ method: 'echo', params: { x: 42 } });

        const err = await client.rpc('req-2', 'nope');
        expect(err.error).toBe('unknown method: nope');

        expect(rig.rpcCalls).toHaveLength(2);
        expect(rig.rpcCalls[0]).toMatchObject({ id: 'req-1', method: 'echo' });

        client.disconnect();
    });

    // ── Eviction ──────────────────────────────────────────────────────────────

    it('eviction: second client connecting displaces the first', async () => {
        // First client connects via QR; the nonce is now consumed.
        const first = rig.makeClient();
        first.client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(first.client, 'connected');
        const savedFirst = first.storage.loadCredentials()!;

        // Second client reconnects via the same (valid) credential, evicting
        // the first. Agent uses the server's `replaced` close code (1000).
        const second = rig.makeClient(savedFirst);
        second.client.connectFromStored(savedFirst);
        await waitForStatus(second.client, 'connected');

        // First client's socket was closed by the server → its local status
        // transitions to 'disconnected' (reconnect will be scheduled but we
        // stop it immediately after observing the state change).
        await waitForStatus(first.client, 'disconnected');
        first.client.disconnect();
        second.client.disconnect();
    });
});

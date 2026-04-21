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
        expect(saved?.sessionId).toBe(rig.connectionSessionId);
        expect(saved?.webappPublicKey).toBe('wa-pub');
        // credential is a JSON string containing { payload, signature }
        expect(saved?.sessionCredential).toMatch(/"signature"/);
        // No messages yet for the auto-created chat session.
        expect(client.getLastSeq(rig.chatSessionId)).toBe(-1);

        // welcome.sessions carries the auto-created chat session metadata.
        expect(client.getSessions().map((s) => s.id)).toEqual([rig.chatSessionId]);

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

    it('user input round-trip: client sendInput reaches agent (agent stores + echoes via handleInput in prod, recorded here)', async () => {
        const { client } = rig.makeClient();
        const received: Array<{ sessionId: string; payload: unknown; seq: number }> = [];
        client.onMessage((sessionId, payload, seq) =>
            received.push({ sessionId, payload, seq }),
        );

        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');

        client.sendInput(rig.chatSessionId, 'hello agent');
        await waitFor(() => rig.inputs.length >= 1);
        expect(rig.inputs).toEqual(['hello agent']);

        // Since the E2E rig intentionally bypasses the manager's handleInput
        // (to avoid spawning a real Claude subprocess), we synthesize the
        // user-event broadcast that production would emit.
        rig.pushChatEvent({
            type: 'user',
            message: { role: 'user', content: 'hello agent' },
        });
        await waitFor(() => received.length >= 1);

        expect(received[0]).toEqual({
            sessionId: rig.chatSessionId,
            seq: 0,
            payload: { type: 'user', message: { role: 'user', content: 'hello agent' } },
        });
        expect(client.getLastSeq(rig.chatSessionId)).toBe(0);

        client.disconnect();
    });

    it('seq is per-session: interleaved broadcasts in the same chat increment one counter', async () => {
        const { client } = rig.makeClient();
        const received: Array<{ sessionId: string; payload: unknown; seq: number }> = [];
        client.onMessage((sessionId, payload, seq) =>
            received.push({ sessionId, payload, seq }),
        );

        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');

        rig.pushChatEvent({ type: 'user', message: { role: 'user', content: 'first' } }); // seq 0
        await waitFor(() => received.length >= 1);

        rig.pushChatEvent({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }); // seq 1
        await waitFor(() => received.length >= 2);

        rig.pushChatEvent({ type: 'user', message: { role: 'user', content: 'second' } }); // seq 2
        await waitFor(() => received.length >= 3);

        expect(received.map((r) => r.seq)).toEqual([0, 1, 2]);
        expect(received.every((r) => r.sessionId === rig.chatSessionId)).toBe(true);
        expect(received[0].payload).toMatchObject({ type: 'user' });
        expect(received[1].payload).toMatchObject({ type: 'assistant' });
        expect(received[2].payload).toMatchObject({ type: 'user' });
        expect(client.getLastSeq(rig.chatSessionId)).toBe(2);

        client.disconnect();
    });

    // ── Reconnect & delta replay ──────────────────────────────────────────────

    it('reconnect delta: client receives only missing messages after disconnect', async () => {
        const { client, storage } = rig.makeClient();
        const received: number[] = [];
        client.onMessage((_sid, _p, seq) => received.push(seq));

        client.connectFirstTime(rig.qrPayload, 'wa-pub');
        await waitForStatus(client, 'connected');

        rig.pushChatEvent({ type: 'user', message: { role: 'user', content: 'live' } }); // seq 0
        await waitFor(() => received.length >= 1);

        // Disconnect; save the creds the client persisted.
        const saved = storage.loadCredentials();
        expect(saved).not.toBeNull();
        client.disconnect();

        // Agent produces more events while the client is offline.
        rig.pushChatEvent({ type: 'tool_use', id: 'x', name: 'Read' }); // seq 1
        rig.pushChatEvent({ type: 'assistant', text: 'done' }); // seq 2

        // New client reconnects from stored credentials.
        const resumed = rig.makeClient(saved);
        const replayed: Array<{ sessionId: string; seq: number }> = [];
        resumed.client.onMessage((sid, _p, seq) => replayed.push({ sessionId: sid, seq }));
        resumed.client.connectFromStored(saved as StoredCredentials);
        await waitForStatus(resumed.client, 'connected');

        // Only the two messages emitted while offline should arrive — not seq 0.
        await waitFor(() => replayed.length >= 2);
        expect(replayed.map((r) => r.seq)).toEqual([1, 2]);
        expect(replayed.every((r) => r.sessionId === rig.chatSessionId)).toBe(true);
        expect(resumed.client.getLastSeq(rig.chatSessionId)).toBe(2);

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

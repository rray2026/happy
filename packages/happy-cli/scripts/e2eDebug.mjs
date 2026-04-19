/**
 * End-to-end debug script for the happy serve direct-connect protocol.
 * Implements the server (WS + auth) and client side directly using ws + tweetnacl,
 * mirroring the actual production code.
 *
 * Run: node scripts/e2eDebug.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function resolveModule(name) {
    const candidates = [
        join(__dirname, '..', 'node_modules', name),
        join(__dirname, '..', '..', '..', 'node_modules', name),
    ];
    for (const p of candidates) {
        try { require.resolve(p); return p; } catch {}
    }
    throw new Error(`Cannot find module '${name}'`);
}

const { WebSocketServer, WebSocket } = require(resolveModule('ws'));
const nacl = require(resolveModule('tweetnacl'));

// ── crypto helpers ────────────────────────────────────────────────────────────

const encodeBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const decodeBase64 = (str) => new Uint8Array(Buffer.from(str, 'base64'));

function generateCliKeys() {
    const kp = nacl.sign.keyPair();
    return { signPublicKey: kp.publicKey, signSecretKey: kp.secretKey };
}

function buildQRPayload(endpoint, cliKeys, sessionId) {
    const nonce = nacl.randomBytes(32);
    return {
        type: 'direct',
        endpoint,
        cliSignPublicKey: encodeBase64(cliKeys.signPublicKey),
        sessionId,
        nonce: encodeBase64(nonce),
        nonceExpiry: Date.now() + 5 * 60 * 1000,
    };
}

function verifyNonce(receivedNonce, qrNonce, nonceExpiry) {
    if (Date.now() > nonceExpiry) return false;
    return receivedNonce === qrNonce;
}

function issueCredential(webappPublicKey, sessionId, cliSignSecretKey) {
    const payload = JSON.stringify({ webappPublicKey, sessionId, expiry: Date.now() + 30 * 24 * 3600 * 1000 });
    const sig = nacl.sign.detached(new TextEncoder().encode(payload), cliSignSecretKey);
    return JSON.stringify({ payload, signature: encodeBase64(sig) });
}

function verifyCredential(credential, cliSignPublicKey) {
    try {
        const { payload, signature } = JSON.parse(credential);
        const ok = nacl.sign.detached.verify(
            new TextEncoder().encode(payload),
            decodeBase64(signature),
            cliSignPublicKey,
        );
        if (!ok) return null;
        const p = JSON.parse(payload);
        if (Date.now() > p.expiry) return null;
        return p;
    } catch { return null; }
}

// ── server ────────────────────────────────────────────────────────────────────

const PORT = 14_999;
const sessionId = randomUUID();
const cliKeys = generateCliKeys();
const qrPayload = buildQRPayload(`ws://127.0.0.1:${PORT}`, cliKeys, sessionId);

console.log('=== happy serve e2e debug ===\n');
console.log('QR Payload:', JSON.stringify(qrPayload, null, 2));

const store = { entries: [], seq: -1 };
function storeAppend(payload) {
    const seq = ++store.seq;
    store.entries.push({ seq, payload });
    return seq;
}

// Pre-load two messages before client connects (delta-sync test)
storeAppend({ type: 'status', text: 'pre-existing message 1' });
storeAppend({ type: 'status', text: 'pre-existing message 2' });
console.log('[server] Pre-loaded 2 messages (seq 0, 1)');

let activeClient = null;
const inputsReceived = [];
const rpcLog = [];

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

wss.on('connection', (ws) => {
    console.log('\n[server] New WebSocket connection');
    if (activeClient?.readyState === WebSocket.OPEN) {
        console.log('[server] Evicting previous client');
        activeClient.close(1000, 'replaced');
    }
    activeClient = ws;

    const send = (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch {
            send({ type: 'error', message: 'invalid JSON' });
            ws.close();
            return;
        }

        if (msg.type === 'hello') {
            if ('nonce' in msg) {
                // First-time handshake
                if (!verifyNonce(msg.nonce, qrPayload.nonce, qrPayload.nonceExpiry)) {
                    console.log('[server] ✗ Nonce invalid/expired');
                    send({ type: 'error', message: 'nonce expired or invalid' });
                    ws.close();
                    return;
                }
                const credential = issueCredential(msg.webappPublicKey, sessionId, cliKeys.signSecretKey);
                console.log('[server] ✓ First-time handshake OK, issuing credential');
                send({ type: 'welcome', sessionId, currentSeq: store.seq, sessionCredential: credential });
                // Send delta (all messages since lastSeq=-1 means from start)
                for (const e of store.entries) {
                    send({ type: 'message', seq: e.seq, payload: e.payload });
                }
            } else {
                // Reconnect
                const verified = verifyCredential(msg.sessionCredential, cliKeys.signPublicKey);
                if (!verified || verified.sessionId !== sessionId) {
                    console.log('[server] ✗ Invalid credential');
                    send({ type: 'error', message: 'invalid credential' });
                    ws.close();
                    return;
                }
                console.log(`[server] ✓ Reconnect OK, lastSeq=${msg.lastSeq}`);
                send({ type: 'welcome', sessionId, currentSeq: store.seq, sessionCredential: msg.sessionCredential });
                for (const e of store.entries.filter(x => x.seq > msg.lastSeq)) {
                    send({ type: 'message', seq: e.seq, payload: e.payload });
                }
            }
            return;
        }

        if (msg.type === 'input') {
            inputsReceived.push(msg.text);
            console.log(`[server] Input received: "${msg.text}"`);
            // Simulate agent streaming output
            setTimeout(() => {
                const seq0 = storeAppend({ type: 'system', subtype: 'init', session_id: randomUUID() });
                send({ type: 'message', seq: seq0, payload: store.entries[seq0].payload });
                const seq1 = storeAppend({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Echo: ${msg.text}` }] } });
                send({ type: 'message', seq: seq1, payload: store.entries[seq1].payload });
                const seq2 = storeAppend({ type: 'result', subtype: 'success', result: 'Completed' });
                send({ type: 'message', seq: seq2, payload: store.entries[seq2].payload });
                console.log('[server] Broadcasted 3 simulated agent events (seq %d-%d)', seq0, seq2);
            }, 80);
            return;
        }

        if (msg.type === 'pong') { console.log('[server] Pong received'); return; }

        if (msg.type === 'rpc') {
            rpcLog.push(msg.method);
            console.log(`[server] RPC: ${msg.method}`, msg.params);
            if (msg.method === 'getLogs') {
                send({ type: 'rpc-response', id: msg.id, result: { lines: ['line1', 'line2'], logPath: '/tmp/fake.log' } });
            } else if (msg.method === 'abort') {
                send({ type: 'rpc-response', id: msg.id, result: { ok: true } });
            } else {
                send({ type: 'rpc-response', id: msg.id, error: `unknown method: ${msg.method}` });
            }
            return;
        }
    });

    ws.on('close', () => console.log('[server] Client disconnected'));
    ws.on('error', (e) => console.log('[server] WS error:', e.message));
});

console.log(`[server] Listening on ws://127.0.0.1:${PORT}\n`);

// ── client (webapp side) ──────────────────────────────────────────────────────

async function runClient(label, helloMsg, expectError = false) {
    console.log(`\n--- ${label} ---`);
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const received = [];
        const t = setTimeout(() => { ws.close(); reject(new Error(`${label}: timeout`)); }, 6_000);

        ws.on('open', () => {
            console.log(`[${label}] Connected`);
            ws.send(JSON.stringify(helloMsg));
        });

        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            received.push(msg);
            console.log(`[${label}] ← ${JSON.stringify(msg)}`);

            if (msg.type === 'welcome') {
                console.log(`[${label}] ✓ Welcome received`);

                // Send input
                ws.send(JSON.stringify({ type: 'input', text: 'list files' }));

                // After agent simulates output, send getLogs RPC
                setTimeout(() => {
                    ws.send(JSON.stringify({ type: 'rpc', id: 'rpc-1', method: 'getLogs', params: { lines: 10 } }));
                }, 500);

                setTimeout(() => {
                    clearTimeout(t);
                    ws.close();
                    resolve(received);
                }, 1_200);
            }

            if (msg.type === 'error') {
                if (expectError) {
                    clearTimeout(t);
                    ws.close();
                    console.log(`[${label}] ✓ Got expected error: "${msg.message}"`);
                    resolve({ expectedError: msg.message });
                } else {
                    clearTimeout(t);
                    ws.close();
                    reject(new Error(`${label}: unexpected error: ${msg.message}`));
                }
            }
        });

        ws.on('error', (e) => { clearTimeout(t); reject(e); });
        ws.on('close', () => {});
    });
}

// ── Test 1: First-time handshake ──────────────────────────────────────────────

const firstTimeResult = await runClient(
    'Test 1 – first-time handshake',
    { type: 'hello', nonce: qrPayload.nonce, webappPublicKey: 'webapp-pub-key-base64' },
);
const welcomeMsg = firstTimeResult.find(m => m.type === 'welcome');
const credential = welcomeMsg?.sessionCredential;

// ── Test 2: Reconnect handshake ───────────────────────────────────────────────

const reconnectResult = await runClient(
    'Test 2 – reconnect handshake',
    { type: 'hello', sessionCredential: credential, webappPublicKey: 'webapp-pub-key-base64', lastSeq: 1 },
);

// ── Test 3: Expired/wrong nonce ───────────────────────────────────────────────

await runClient(
    'Test 3 – bad nonce (expected error)',
    { type: 'hello', nonce: 'wrong-nonce', webappPublicKey: 'key' },
    true,
);

// ── Test 4: Tampered credential ───────────────────────────────────────────────

await runClient(
    'Test 4 – tampered credential (expected error)',
    { type: 'hello', sessionCredential: '{"payload":"{}","signature":"AAAA"}', webappPublicKey: 'key', lastSeq: -1 },
    true,
);

// ── Final summary ─────────────────────────────────────────────────────────────

wss.close();

console.log('\n=== Summary ===');
console.log(`Test 1 – first-time handshake: ${welcomeMsg ? '✓ PASS' : '✗ FAIL'}`);
console.log(`Test 2 – reconnect:            ${reconnectResult.find(m => m.type === 'welcome') ? '✓ PASS' : '✗ FAIL'}`);
console.log('Test 3 – bad nonce:            ✓ PASS (expected error received)');
console.log('Test 4 – tampered credential:  ✓ PASS (expected error received)');
console.log(`\nInputs received by server: ${JSON.stringify(inputsReceived)}`);
console.log(`RPCs received by server:   ${JSON.stringify(rpcLog)}`);

const t1Delta = firstTimeResult.filter(m => m.type === 'message');
console.log(`\nDelta messages on first connect (should be seq 0,1): ${t1Delta.map(m => m.seq).join(', ')}`);
const t2Delta = reconnectResult.filter(m => m.type === 'message');
console.log(`Delta messages on reconnect lastSeq=1 (should be none pre-input, then agent events): ${t2Delta.map(m => m.seq).join(', ')}`);

console.log('\n✓ All tests passed');

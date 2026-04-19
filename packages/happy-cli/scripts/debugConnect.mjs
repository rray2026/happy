/**
 * Debug client for `happy serve` direct-connect protocol.
 * Usage: node scripts/debugConnect.mjs '<qr-payload-json>'
 *
 * The QR payload JSON is the object printed/encoded by `happy serve`.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve modules — check local node_modules first, fall back to root
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

const { WebSocket } = require(resolveModule('ws'));
const tweetnacl = require(resolveModule('tweetnacl'));

// ── helpers ───────────────────────────────────────────────────────────────────

function encodeBase64(bytes) {
    return Buffer.from(bytes).toString('base64');
}

function decodeBase64(str) {
    return new Uint8Array(Buffer.from(str, 'base64'));
}

// ── main ──────────────────────────────────────────────────────────────────────

const raw = process.argv[2];
if (!raw) {
    // fall back to reading from stdin
    process.stderr.write('Usage: node scripts/debugConnect.mjs \'<qr-payload-json>\'\n');
    process.exit(1);
}

const qr = JSON.parse(raw);
console.log('\n=== QR Payload ===');
console.log(JSON.stringify(qr, null, 2));

const nonceExpiry = new Date(qr.nonceExpiry);
const now = new Date();
console.log(`\nNonce expiry: ${nonceExpiry.toISOString()} (${nonceExpiry > now ? 'VALID' : 'EXPIRED'})`);
console.log(`Now:          ${now.toISOString()}`);

if (nonceExpiry <= now) {
    console.error('\n⚠ Nonce is expired — first-time handshake will fail. Start a fresh `happy serve` session.');
    process.exit(1);
}

// Generate a webapp Ed25519 keypair
const webappKp = tweetnacl.sign.keyPair();
const webappPublicKey = encodeBase64(webappKp.publicKey);
console.log(`\nWebapp public key (generated): ${webappPublicKey}`);

console.log(`\nConnecting to ${qr.endpoint} …`);

const ws = new WebSocket(qr.endpoint);

const TIMEOUT_MS = 10_000;
const timer = setTimeout(() => {
    console.error('\n⏱ Timed out waiting for server response');
    ws.close();
    process.exit(1);
}, TIMEOUT_MS);

ws.on('open', () => {
    console.log('✓ WebSocket connection established');

    const hello = {
        type: 'hello',
        nonce: qr.nonce,
        webappPublicKey,
    };
    console.log('\n→ Sending hello (first-time):');
    console.log(JSON.stringify(hello, null, 2));
    ws.send(JSON.stringify(hello));
});

ws.on('message', (raw) => {
    clearTimeout(timer);
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch {
        console.error('\n✗ Server sent non-JSON:', raw.toString());
        ws.close();
        return;
    }

    console.log('\n← Received:', JSON.stringify(msg, null, 2));

    if (msg.type === 'welcome') {
        console.log('\n✓ Handshake SUCCESS');
        console.log(`  sessionId:        ${msg.sessionId}`);
        console.log(`  currentSeq:       ${msg.currentSeq}`);
        console.log(`  sessionCredential length: ${msg.sessionCredential?.length}`);

        // Verify the credential signature using cliSignPublicKey from QR
        try {
            const cliSignPublicKey = decodeBase64(qr.cliSignPublicKey);
            const { payload: payloadJson, signature: sigB64 } = JSON.parse(msg.sessionCredential);
            const payloadBytes = new TextEncoder().encode(payloadJson);
            const signature = decodeBase64(sigB64);
            const ok = tweetnacl.sign.detached.verify(payloadBytes, signature, cliSignPublicKey);
            console.log(`  Credential signature valid: ${ok ? '✓ YES' : '✗ NO'}`);
            const payload = JSON.parse(payloadJson);
            console.log(`  Credential payload: ${JSON.stringify(payload, null, 4)}`);
        } catch (e) {
            console.error(`  ✗ Could not verify credential: ${e.message}`);
        }

        // Send a test RPC call for getLogs
        const rpcMsg = { type: 'rpc', id: 'debug-1', method: 'getLogs', params: { lines: '10' } };
        console.log('\n→ Sending RPC (getLogs):');
        console.log(JSON.stringify(rpcMsg, null, 2));
        ws.send(JSON.stringify(rpcMsg));

        // Close after 3 seconds
        setTimeout(() => {
            console.log('\nClosing connection (debug done).');
            ws.close();
        }, 3000);
    } else if (msg.type === 'error') {
        console.error(`\n✗ Server returned error: ${msg.message}`);
        ws.close();
    } else if (msg.type === 'rpc-response') {
        console.log('\n← RPC response received ✓');
    } else if (msg.type === 'message') {
        console.log(`\n← Buffered message seq=${msg.seq}`);
    }
});

ws.on('error', (err) => {
    clearTimeout(timer);
    console.error(`\n✗ WebSocket error: ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
        console.error('  → Server is not reachable. Check the endpoint address and that `happy serve` is running.');
    } else if (err.code === 'ENOTFOUND') {
        console.error('  → Hostname not resolved. Check the endpoint.');
    }
    process.exit(1);
});

ws.on('close', (code, reason) => {
    clearTimeout(timer);
    console.log(`\nConnection closed (code=${code}${reason?.length ? ', reason=' + reason : ''})`);
    process.exit(0);
});

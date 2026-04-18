import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '@/ui/logger';
import { SessionStore } from './sessionStore';
import { verifyNonce, verifyCredential, issueCredential } from './directAuth';
import type {
    CliKeys,
    DirectQRPayload,
    WsServerHandle,
    RpcHandler,
    InputHandler,
    WebappMessage,
    CliMessage,
} from './types';

const PING_INTERVAL_MS = 30_000;

/**
 * Start an embedded WebSocket server that listens on all interfaces (0.0.0.0).
 * For public exposure, an nginx/caddy reverse proxy on the user's machine is
 * responsible for TLS termination and forwarding traffic to this port.
 *
 * Only one webapp client is supported at a time. A new connection will
 * disconnect the previous one.
 */
export function startWsServer(opts: {
    port: number;
    sessionId: string;
    cliKeys: CliKeys;
    qrPayload: DirectQRPayload;
    onRpc: RpcHandler;
    onInput: InputHandler;
}): WsServerHandle {
    const { port, sessionId, cliKeys, qrPayload, onRpc, onInput } = opts;
    const store = new SessionStore(200);

    let activeClient: WebSocket | null = null;
    let pingTimer: NodeJS.Timeout | null = null;

    const wss = new WebSocketServer({ host: '0.0.0.0', port });

    function send(ws: WebSocket, msg: CliMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    function clearPingTimer(): void {
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
    }

    function startPingTimer(ws: WebSocket): void {
        clearPingTimer();
        pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                send(ws, { type: 'ping' });
            }
        }, PING_INTERVAL_MS);
    }

    function completeHandshake(
        ws: WebSocket,
        webappPublicKey: string,
        credential: string,
        lastSeq: number,
    ): void {
        send(ws, {
            type: 'welcome',
            sessionId,
            currentSeq: store.getCurrentSeq(),
            sessionCredential: credential,
        });

        // Send delta messages (gap silently dropped per design)
        for (const entry of store.getDelta(lastSeq)) {
            send(ws, { type: 'message', seq: entry.seq, payload: entry.payload });
        }

        startPingTimer(ws);
    }

    wss.on('connection', (ws) => {
        logger.debug('[wsServer] New connection');

        // Evict any existing client
        if (activeClient && activeClient.readyState === WebSocket.OPEN) {
            logger.debug('[wsServer] Evicting previous client');
            activeClient.close(1000, 'replaced');
        }
        activeClient = ws;

        ws.on('message', (raw) => {
            let msg: WebappMessage;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                send(ws, { type: 'error', message: 'invalid JSON' });
                ws.close();
                return;
            }

            if (msg.type === 'hello') {
                if ('nonce' in msg) {
                    // ── First-time handshake ──────────────────────────────
                    if (!verifyNonce(msg.nonce, qrPayload.nonce, qrPayload.nonceExpiry)) {
                        logger.debug('[wsServer] Nonce invalid or expired');
                        send(ws, { type: 'error', message: 'nonce expired or invalid' });
                        ws.close();
                        return;
                    }
                    const credential = issueCredential(
                        msg.webappPublicKey,
                        sessionId,
                        cliKeys.signSecretKey,
                    );
                    logger.debug('[wsServer] First-time handshake OK');
                    completeHandshake(ws, msg.webappPublicKey, credential, -1);
                } else {
                    // ── Reconnect handshake ───────────────────────────────
                    const verified = verifyCredential(msg.sessionCredential, cliKeys.signPublicKey);
                    if (!verified || verified.sessionId !== sessionId) {
                        logger.debug('[wsServer] Credential invalid');
                        send(ws, { type: 'error', message: 'invalid credential' });
                        ws.close();
                        return;
                    }
                    logger.debug('[wsServer] Reconnect handshake OK, lastSeq=%d', msg.lastSeq);
                    completeHandshake(ws, msg.webappPublicKey, msg.sessionCredential, msg.lastSeq);
                }
                return;
            }

            if (msg.type === 'pong') return;

            if (msg.type === 'input') {
                onInput(msg.text);
                return;
            }

            if (msg.type === 'rpc') {
                onRpc(msg.id, msg.method, msg.params).catch((err) => {
                    logger.debug('[wsServer] RPC handler error: %s', err?.message);
                    send(ws, { type: 'rpc-response', id: msg.id, error: String(err?.message ?? err) });
                });
                return;
            }
        });

        ws.on('close', () => {
            logger.debug('[wsServer] Client disconnected');
            if (activeClient === ws) {
                activeClient = null;
                clearPingTimer();
            }
        });

        ws.on('error', (err) => {
            logger.debug('[wsServer] WebSocket error: %s', err.message);
        });
    });

    wss.on('error', (err) => {
        logger.debug('[wsServer] Server error: %s', err.message);
    });

    return {
        broadcast(payload: unknown): number {
            const seq = store.append(payload);
            if (activeClient && activeClient.readyState === WebSocket.OPEN) {
                send(activeClient, { type: 'message', seq, payload });
            }
            return seq;
        },

        sendRpcResponse(id: string, result: unknown | null, error?: string): void {
            if (activeClient && activeClient.readyState === WebSocket.OPEN) {
                send(activeClient, { type: 'rpc-response', id, result: result ?? undefined, error });
            }
        },

        close(): void {
            clearPingTimer();
            wss.close();
        },
    };
}

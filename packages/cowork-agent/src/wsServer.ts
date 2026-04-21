import { WebSocket, WebSocketServer } from 'ws';
import { issueCredential, verifyCredential, verifyNonce } from './auth.js';
import { logger } from './logger.js';
import { SessionStore } from './sessionStore.js';
import type {
    CliKeys,
    CliMessage,
    DirectQRPayload,
    InputHandler,
    RpcHandler,
    WebappMessage,
    WsServerHandle,
} from './types.js';

const PING_INTERVAL_MS = 30_000;

/**
 * Start a WebSocket server. Binds to 127.0.0.1 by default; callers can opt into
 * a different host (e.g. 0.0.0.0) when remote exposure is intended. Only one
 * webapp may be connected at a time — a new connection evicts the previous one.
 */
export function startWsServer(opts: {
    port: number;
    host?: string;
    sessionId: string;
    cliKeys: CliKeys;
    qrPayload: DirectQRPayload;
    onRpc: RpcHandler;
    onInput: InputHandler;
}): WsServerHandle {
    const { port, sessionId, cliKeys, qrPayload, onRpc, onInput } = opts;
    const host = opts.host ?? '127.0.0.1';
    const store = new SessionStore(200);

    let activeClient: WebSocket | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let nonceConsumed = false;

    const wss = new WebSocketServer({ host, port });

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
            if (ws.readyState === WebSocket.OPEN) send(ws, { type: 'ping' });
        }, PING_INTERVAL_MS);
    }

    function completeHandshake(ws: WebSocket, credential: string, lastSeq: number): void {
        send(ws, {
            type: 'welcome',
            sessionId,
            currentSeq: store.getCurrentSeq(),
            sessionCredential: credential,
        });
        for (const entry of store.getDelta(lastSeq)) {
            send(ws, { type: 'message', seq: entry.seq, payload: entry.payload });
        }
        startPingTimer(ws);
    }

    wss.on('connection', (ws) => {
        logger.debug('[wsServer] new connection');

        if (activeClient && activeClient.readyState === WebSocket.OPEN) {
            logger.debug('[wsServer] evicting previous client');
            activeClient.close(1000, 'replaced');
        }
        activeClient = ws;

        ws.on('message', (raw) => {
            let msg: WebappMessage;
            try {
                msg = JSON.parse(raw.toString()) as WebappMessage;
            } catch {
                send(ws, { type: 'error', message: 'invalid JSON' });
                ws.close();
                return;
            }

            if (msg.type === 'hello') {
                if ('nonce' in msg) {
                    if (
                        !verifyNonce(
                            msg.nonce,
                            qrPayload.nonce,
                            qrPayload.nonceExpiry,
                            nonceConsumed,
                        )
                    ) {
                        logger.debug(
                            `[wsServer] nonce invalid/expired/consumed (consumed=${nonceConsumed})`,
                        );
                        send(ws, { type: 'error', message: 'nonce expired or invalid' });
                        ws.close();
                        return;
                    }
                    nonceConsumed = true;
                    const credential = issueCredential(
                        msg.webappPublicKey,
                        sessionId,
                        cliKeys.signSecretKey,
                    );
                    logger.debug('[wsServer] first-time handshake ok; nonce consumed');
                    completeHandshake(ws, credential, -1);
                } else {
                    const verified = verifyCredential(msg.sessionCredential, cliKeys.signPublicKey);
                    if (!verified || verified.sessionId !== sessionId) {
                        logger.debug('[wsServer] credential invalid');
                        send(ws, { type: 'error', message: 'invalid credential' });
                        ws.close();
                        return;
                    }
                    logger.debug(`[wsServer] reconnect ok, lastSeq=${msg.lastSeq}`);
                    completeHandshake(ws, msg.sessionCredential, msg.lastSeq);
                }
                return;
            }

            if (msg.type === 'pong') return;

            if (msg.type === 'input') {
                onInput(msg.text);
                return;
            }

            if (msg.type === 'rpc') {
                onRpc(msg.id, msg.method, msg.params).catch((err: Error) => {
                    logger.debug('[wsServer] rpc handler error:', err?.message);
                    send(ws, { type: 'rpc-response', id: msg.id, error: String(err?.message ?? err) });
                });
                return;
            }
        });

        ws.on('close', () => {
            logger.debug('[wsServer] client disconnected');
            if (activeClient === ws) {
                activeClient = null;
                clearPingTimer();
            }
        });

        ws.on('error', (err) => {
            logger.debug('[wsServer] ws error:', err.message);
        });
    });

    wss.on('error', (err) => {
        logger.debug('[wsServer] server error:', err.message);
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
                send(activeClient, {
                    type: 'rpc-response',
                    id,
                    result: result ?? undefined,
                    error,
                });
            }
        },

        replayFrom(fromSeq: number): void {
            if (activeClient && activeClient.readyState === WebSocket.OPEN) {
                for (const entry of store.getDelta(fromSeq)) {
                    send(activeClient, { type: 'message', seq: entry.seq, payload: entry.payload });
                }
            }
        },

        close(): void {
            clearPingTimer();
            wss.close();
        },
    };
}

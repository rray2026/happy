import { WebSocket, WebSocketServer } from 'ws';
import { issueCredential, verifyCredential, verifyNonce } from './auth.js';
import { logger } from './logger.js';
import { HandshakeInboundSchema, SessionInboundSchema } from './schemas.js';
import type { SessionMeta } from './sessionManager.js';
import type {
    CliKeys,
    CliMessage,
    DirectQRPayload,
    InputHandler,
    RpcHandler,
    WsServerHandle,
} from './types.js';

const PING_INTERVAL_MS = 30_000;

type ConnState = 'handshake' | 'established';

/** Per-session replay fetcher: returns the stream slice with seq > fromSeq. */
export type ReplayFetcher = (
    sessionId: string,
    fromSeq: number,
) => Array<{ seq: number; payload: unknown }>;

/**
 * WebSocket server with a two-phase protocol.
 *
 *   Phase 1 (handshake): client must send exactly one `hello` message
 *     (first-time or reconnect). Agent replies `welcome` (carrying the current
 *     session list) on success, or `error` and closes on failure.
 *   Phase 2 (session): after handshake, only `input` / `rpc` / `pong` are
 *     accepted. All `input` messages are keyed by a chat `sessionId`.
 *
 * Binds to 127.0.0.1 by default. Only one webapp may be connected at a time —
 * a new connection evicts the previous one.
 */
export function startWsServer(opts: {
    port: number;
    host?: string;
    sessionId: string;
    cliKeys: CliKeys;
    qrPayload: DirectQRPayload;
    onRpc: RpcHandler;
    onInput: InputHandler;
    /** Snapshot of every live chat session — embedded in `welcome`. */
    listSessions: () => SessionMeta[];
    /** Called once per session on reconnect to pump the delta to the client. */
    replayFrom: ReplayFetcher;
}): WsServerHandle {
    const { port, sessionId, cliKeys, qrPayload, onRpc, onInput, listSessions, replayFrom } = opts;
    const host = opts.host ?? '127.0.0.1';

    let activeClient: WebSocket | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let nonceConsumed = false;

    const wss = new WebSocketServer({ host, port });
    const readyPromise = new Promise<void>((resolve, reject) => {
        wss.once('listening', () => resolve());
        wss.once('error', reject);
    });

    function send(ws: WebSocket, msg: CliMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    function fail(ws: WebSocket, message: string): void {
        send(ws, { type: 'error', message });
        ws.close();
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

    function completeHandshake(
        ws: WebSocket,
        credential: string,
        lastSeqs: Record<string, number>,
    ): void {
        const sessions = listSessions();
        send(ws, {
            type: 'welcome',
            sessionId,
            sessionCredential: credential,
            sessions,
        });
        for (const s of sessions) {
            const from = Object.prototype.hasOwnProperty.call(lastSeqs, s.id) ? lastSeqs[s.id] : -1;
            for (const entry of replayFrom(s.id, from)) {
                send(ws, {
                    type: 'message',
                    sessionId: s.id,
                    seq: entry.seq,
                    payload: entry.payload,
                });
            }
        }
        startPingTimer(ws);
    }

    // ── Phase 1: handshake ──────────────────────────────────────────────────
    function handleHandshake(ws: WebSocket, raw: unknown): ConnState {
        const parsed = HandshakeInboundSchema.safeParse(raw);
        if (!parsed.success) {
            logger.debug('[wsServer] handshake: schema rejected');
            fail(ws, 'expected hello message');
            return 'handshake';
        }
        const msg = parsed.data;

        if ('nonce' in msg) {
            if (!verifyNonce(msg.nonce, qrPayload.nonce, qrPayload.nonceExpiry, nonceConsumed)) {
                logger.debug(
                    `[wsServer] nonce invalid/expired/consumed (consumed=${nonceConsumed})`,
                );
                fail(ws, 'nonce expired or invalid');
                return 'handshake';
            }
            nonceConsumed = true;
            const credential = issueCredential(
                msg.webappPublicKey,
                sessionId,
                cliKeys.signSecretKey,
            );
            logger.debug('[wsServer] first-time handshake ok; nonce consumed');
            completeHandshake(ws, credential, {});
            return 'established';
        }

        const verified = verifyCredential(msg.sessionCredential, cliKeys.signPublicKey);
        if (!verified || verified.sessionId !== sessionId) {
            logger.debug('[wsServer] credential invalid');
            fail(ws, 'invalid credential');
            return 'handshake';
        }
        logger.debug(
            `[wsServer] reconnect ok, lastSeqs for ${Object.keys(msg.lastSeqs).length} session(s)`,
        );
        completeHandshake(ws, msg.sessionCredential, msg.lastSeqs);
        return 'established';
    }

    // ── Phase 2: session ────────────────────────────────────────────────────
    function handleSession(ws: WebSocket, raw: unknown): void {
        const parsed = SessionInboundSchema.safeParse(raw);
        if (!parsed.success) {
            logger.debug('[wsServer] session: schema rejected');
            fail(ws, 'invalid session message');
            return;
        }
        const msg = parsed.data;

        if (msg.type === 'pong') return;

        if (msg.type === 'input') {
            onInput(msg.sessionId, msg.text);
            return;
        }

        if (msg.type === 'rpc') {
            onRpc(msg.id, msg.method, msg.params).catch((err: Error) => {
                logger.debug('[wsServer] rpc handler error:', err?.message);
                send(ws, {
                    type: 'rpc-response',
                    id: msg.id,
                    error: String(err?.message ?? err),
                });
            });
            return;
        }
    }

    wss.on('connection', (ws) => {
        logger.debug('[wsServer] new connection');

        if (activeClient && activeClient.readyState === WebSocket.OPEN) {
            logger.debug('[wsServer] evicting previous client');
            activeClient.close(1000, 'replaced');
        }
        activeClient = ws;

        let state: ConnState = 'handshake';

        ws.on('message', (raw) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw.toString());
            } catch {
                fail(ws, 'invalid JSON');
                return;
            }

            if (state === 'handshake') {
                state = handleHandshake(ws, parsed);
                return;
            }

            handleSession(ws, parsed);
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
        port(): number {
            const addr = wss.address();
            if (addr && typeof addr === 'object') return addr.port;
            return port;
        },
        ready(): Promise<void> {
            return readyPromise;
        },
        pushMessage(sid: string, seq: number, payload: unknown): void {
            if (activeClient && activeClient.readyState === WebSocket.OPEN) {
                send(activeClient, { type: 'message', sessionId: sid, seq, payload });
            }
        },
        pushSessionsChanged(sessions: SessionMeta[]): void {
            if (activeClient && activeClient.readyState === WebSocket.OPEN) {
                send(activeClient, { type: 'sessions', sessions });
            }
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
        close(): void {
            clearPingTimer();
            wss.close();
        },
    };
}

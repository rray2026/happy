import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { sessionClient } from '../session';
import type { ChatSessionMeta, ClaudeEvent, Item, PermissionEvent, SocketStatus, ToolCall } from '../types';
import { eventToItems, mergeItems, uid } from '../session/events';
import { MarkdownMessage } from './MarkdownMessage';
import { SessionSidebar } from './SessionSidebar';

// ── Sub-components ────────────────────────────────────────────────────────────

function formatToolInput(input: unknown): string {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try {
        return JSON.stringify(input, null, 2);
    } catch {
        return String(input);
    }
}

const ToolsItem = memo(function ToolsItem({ calls }: { calls: ToolCall[] }) {
    const [open, setOpen] = useState(false);
    const label = calls.length === 1 ? calls[0].name : `${calls.length} tool calls`;
    return (
        <div className="tools-group">
            <button className="tools-header" onClick={() => setOpen((o) => !o)}>
                <span className="tools-icon">⚙</span>
                <span className="tools-label">{label}</span>
                <span className="tools-chevron">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
                <ul className="tools-list">
                    {calls.map((call) => (
                        <li key={call.toolUseId} className="tools-item">
                            <div className="tools-item-name">{call.name}</div>
                            {formatToolInput(call.input) && (
                                <pre className="tools-item-input">{formatToolInput(call.input)}</pre>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
});

const MessageItem = memo(function MessageItem({ item }: { item: Item }) {
    switch (item.kind) {
        case 'user':
            return <div className="msg-user"><div className="msg-user-bubble">{item.text}</div></div>;
        case 'assistant':
            return <div className="msg-assistant"><MarkdownMessage text={item.text} /></div>;
        case 'tools':
            return <div className="msg-tools"><ToolsItem calls={item.calls} /></div>;
        case 'result':
            return (
                <div className={`msg-result ${item.success ? 'success' : 'error'}`}>
                    {item.success ? '✓' : '✗'} {item.text}
                </div>
            );
        case 'status':
            return <div className="msg-status">{item.text}</div>;
    }
});

const TypingDots = memo(function TypingDots() {
    return (
        <div className="typing-dots">
            <span /><span /><span />
        </div>
    );
});

// ── Main ──────────────────────────────────────────────────────────────────────

export function ChatScreen() {
    const navigate = useNavigate();
    const params = useParams<{ sessionId: string }>();
    const sessionId = params.sessionId ?? '';

    const [status, setStatus] = useState<SocketStatus>(sessionClient.getStatus());
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());
    const [items, setItems] = useState<Item[]>([]);
    const [input, setInput] = useState('');
    const [thinking, setThinking] = useState(false);
    const [permission, setPermission] = useState<PermissionEvent | null>(null);
    const [logsOpen, setLogsOpen] = useState(false);
    const [logLines, setLogLines] = useState<string[]>([]);
    const [logPath, setLogPath] = useState('');
    const [logsLoading, setLogsLoading] = useState(false);

    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const logsBottomRef = useRef<HTMLDivElement>(null);
    /**
     * Per-session seq dedupe. SessionClient tracks `lastSeqs` but dispatches
     * every inbound `message` unconditionally (it has no payload cache), so a
     * `session.replay` RPC that re-emits the entire stream will deliver events
     * that the welcome-handshake delta already delivered. Without dedupe the
     * user would see duplicate items. Cleared on sessionId change.
     */
    const seenSeqs = useRef<Set<number>>(new Set());

    // Reset per-session UI state when the route param changes: different
    // chat → different event stream → different messages.
    useEffect(() => {
        setItems([]);
        setThinking(false);
        setPermission(null);
        seenSeqs.current = new Set();
    }, [sessionId]);

    useEffect(() => {
        const unsubStatus = sessionClient.onStatusChange(setStatus);
        const unsubSessions = sessionClient.onSessionsChange(setSessions);
        const unsubMsg = sessionClient.onMessage((sid, payload, seq) => {
            if (sid !== sessionId) return;
            if (seenSeqs.current.has(seq)) return;
            seenSeqs.current.add(seq);
            if ((payload as PermissionEvent).type === 'permission-request') {
                setPermission(payload as PermissionEvent);
                return;
            }
            const event = payload as ClaudeEvent;
            if (event.type === 'result') setThinking(false);
            const newItems = eventToItems(event);
            if (!newItems.length) return;
            setItems(prev => mergeItems(prev, newItems));
        });

        return () => { unsubStatus(); unsubSessions(); unsubMsg(); };
    }, [sessionId]);

    /**
     * Pull the full event stream for this session once the connection is up.
     *
     * Why: SessionClient's `hello.lastSeqs` only asks the agent to replay
     * events with `seq > lastSeqs[sid]`. After a webapp reload, ChatScreen
     * re-mounts with empty `items` but `lastSeqs` still points at the last
     * seen seq — so the welcome-handshake delta is typically empty and the
     * conversation looks blank. We work around that by explicitly asking the
     * agent to replay from `-1` (the whole buffer, up to SessionStore's
     * circular-buffer cap of 200 entries).
     *
     * Dedupe is handled by `seenSeqs`; this call is safe to fire even when
     * the welcome delta already delivered part of the stream.
     */
    useEffect(() => {
        if (!sessionId) return;
        let cancelled = false;
        const requestReplay = () => {
            if (cancelled) return;
            sessionClient
                .rpc(uid(), 'session.replay', { sessionId, fromSeq: -1 })
                .catch(() => {
                    /* silent: agent disconnects / unknown session ids are
                     * non-fatal; UI will stay empty and recover on next mount. */
                });
        };
        if (sessionClient.getStatus() === 'connected') {
            requestReplay();
            return () => { cancelled = true; };
        }
        // Not yet connected — wait for the first 'connected' transition.
        const unsub = sessionClient.onStatusChange((s) => {
            if (s === 'connected') {
                unsub();
                requestReplay();
            }
        });
        return () => {
            cancelled = true;
            unsub();
        };
    }, [sessionId]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [items, thinking]);

    const activeSession = sessions.find((s) => s.id === sessionId);

    const handleSend = useCallback(() => {
        const text = input.trim();
        if (!text || status !== 'connected' || !sessionId) return;
        sessionClient.sendInput(sessionId, text);
        setInput('');
        setThinking(true);
        setItems(prev => [...prev, { kind: 'user', text, id: uid() }]);
        setTimeout(() => inputRef.current?.focus(), 0);
    }, [input, status, sessionId]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const handlePermission = useCallback((approved: boolean) => {
        if (!permission) return;
        sessionClient
            .rpc(uid(), 'session.permissionResponse', {
                sessionId,
                permissionId: permission.permissionId,
                approved,
            })
            .catch(() => {});
        setPermission(null);
    }, [permission, sessionId]);

    const handleBackToHome = useCallback(() => {
        navigate('/');
    }, [navigate]);

    const handleDisconnect = useCallback(() => {
        sessionClient.disconnect();
        sessionClient.clearCredentials();
        navigate('/');
    }, [navigate]);

    const handleOpenLogs = useCallback(async () => {
        setLogsOpen(true);
        setLogsLoading(true);
        try {
            const res = await sessionClient.rpc(uid(), 'getLogs', { lines: 300 });
            const r = res.result as { lines: string[]; logPath: string } | undefined;
            setLogLines(r?.lines ?? [res.error ?? 'Error fetching logs']);
            setLogPath(r?.logPath ?? '');
        } catch (e) {
            setLogLines([`Failed: ${e instanceof Error ? e.message : String(e)}`]);
        } finally {
            setLogsLoading(false);
            setTimeout(() => logsBottomRef.current?.scrollIntoView(), 100);
        }
    }, []);

    const statusDot = status === 'connected' ? 'dot-green' : status === 'connecting' ? 'dot-orange' : status === 'error' ? 'dot-red' : 'dot-gray';
    const statusLabel = status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Error' : 'Disconnected';

    return (
        <div className="chat-screen">
            <SessionSidebar activeSessionId={sessionId} />

            <div className="chat-main">
                {permission && (
                    <div className="modal-overlay" onClick={() => handlePermission(false)}>
                        <div className="modal-card" onClick={e => e.stopPropagation()}>
                            <h3 className="modal-title">Permission Request</h3>
                            <p className="modal-tool">{permission.toolName}</p>
                            <pre className="modal-input">{JSON.stringify(permission.input, null, 2)}</pre>
                            <div className="modal-actions">
                                <button className="modal-btn deny" onClick={() => handlePermission(false)}>Deny</button>
                                <button className="modal-btn approve" onClick={() => handlePermission(true)}>Approve</button>
                            </div>
                        </div>
                    </div>
                )}

                {logsOpen && (
                    <div className="logs-modal">
                        <div className="logs-header">
                            <div>
                                <div className="logs-title">CLI Logs</div>
                                {logPath && <div className="logs-path">{logPath}</div>}
                            </div>
                            <button className="logs-close" onClick={() => setLogsOpen(false)}>✕</button>
                        </div>
                        <div className="logs-body">
                            {logsLoading
                                ? <div className="logs-loading">Loading…</div>
                                : logLines.length === 0
                                    ? <div className="logs-empty">No log entries.</div>
                                    : logLines.map((line, i) => <div key={i} className="logs-line">{line}</div>)
                            }
                            <div ref={logsBottomRef} />
                        </div>
                    </div>
                )}

                <div className="chat-header">
                    <div className="chat-status">
                        <span className={`status-dot ${statusDot}`} />
                        <span className="status-label">{statusLabel}</span>
                        {activeSession && (
                            <span className="chat-session-label">
                                · {activeSession.tool}
                                {activeSession.model ? ` (${activeSession.model})` : ''}
                            </span>
                        )}
                        {status === 'error' && sessionClient.getLastError() && (
                            <span className="status-error-hint">{sessionClient.getLastError()}</span>
                        )}
                    </div>
                    <div className="chat-header-actions">
                        {status === 'connected' && (
                            <button className="icon-btn" onClick={handleOpenLogs} title="查看日志">📋</button>
                        )}
                        <button className="icon-btn" onClick={handleBackToHome} title="返回首页">⌂</button>
                        <button className="icon-btn disconnect-btn" onClick={handleDisconnect} title="断开并清除">✕</button>
                    </div>
                </div>

                <div className="chat-messages">
                    {items.length === 0 && !thinking && (
                        <div className="chat-empty">
                            {status === 'connected' ? 'How can I help you today?' : 'Waiting for connection…'}
                        </div>
                    )}
                    {items.map(item => <MessageItem key={item.id} item={item} />)}
                    {thinking && <TypingDots />}
                    <div ref={bottomRef} />
                </div>

                <div className="chat-input-bar">
                    <div className="chat-input-wrap">
                        <textarea
                            ref={inputRef}
                            className="chat-textarea"
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Message… (Enter to send, Shift+Enter for newline)"
                            rows={1}
                            disabled={status !== 'connected' || thinking || !sessionId}
                        />
                        <button
                            className="chat-send-btn"
                            onClick={handleSend}
                            disabled={!input.trim() || status !== 'connected' || thinking || !sessionId}
                        >
                            ↑
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

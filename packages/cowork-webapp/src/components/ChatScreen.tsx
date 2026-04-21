import { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ScrollText, EllipsisVertical, Plus, SendHorizontal, ChevronDown, X } from 'lucide-react';
import { sessionClient } from '../session';
import type { ChatSessionMeta, ClaudeEvent, Item, PermissionEvent, SocketStatus, ToolCall } from '../types';
import { eventToItems, mergeItems, uid } from '../session/events';
import { MarkdownMessage } from './MarkdownMessage';
import { SessionSidebar } from './SessionSidebar';
import { Modal } from './Modal';

// ── Helpers ───────────────────────────────────────────────────────────────────

const isTouchDevice = typeof window !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0);

function formatMsgTime(ts?: number): string {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatToolInput(input: unknown): string {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

// ── Sub-components ────────────────────────────────────────────────────────────

const ToolsItem = memo(function ToolsItem({ calls }: { calls: ToolCall[] }) {
    const [open, setOpen] = useState(false);
    const label = calls.length === 1 ? calls[0].name : `${calls.length} 个工具调用`;
    return (
        <div className="tools-group">
            <button
                type="button"
                className="tools-header"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
            >
                <span className="tools-icon" aria-hidden="true">⚙</span>
                <span className="tools-label">{label}</span>
                <span className="tools-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
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
    const time = formatMsgTime(item.timestamp);
    switch (item.kind) {
        case 'user':
            return (
                <div className="msg-user">
                    <div className="msg-user-bubble">{item.text}</div>
                    {time && <div className="msg-time">{time}</div>}
                </div>
            );
        case 'assistant':
            return (
                <div className="msg-assistant">
                    <div className={`msg-assistant-bubble${item.streaming ? ' streaming' : ''}`}>
                        <MarkdownMessage text={item.text} />
                    </div>
                    {!item.streaming && time && <div className="msg-time">{time}</div>}
                </div>
            );
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
        <div className="typing-wrap">
            <div className="typing-dots" aria-label="AI 正在输入">
                <span /><span /><span />
            </div>
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
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [showScrollBtn, setShowScrollBtn] = useState(false);

    const [chromeVisible, setChromeVisible] = useState(true);

    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const logsBottomRef = useRef<HTMLDivElement>(null);
    const messagesRef = useRef<HTMLDivElement>(null);
    const lastScrollTopRef = useRef(0);
    // Keyed by sessionId via the parent route wrapper — seenSeqs initialises fresh
    // on every mount, so no reset effect is needed.
    const seenSeqs = useRef<Set<number>>(new Set());

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

    useEffect(() => {
        if (!sessionId) return;
        let cancelled = false;
        const requestReplay = () => {
            if (cancelled) return;
            sessionClient
                .rpc(uid(), 'session.replay', { sessionId, fromSeq: -1 })
                .catch(() => {});
        };
        if (sessionClient.getStatus() === 'connected') {
            requestReplay();
            return () => { cancelled = true; };
        }
        const unsub = sessionClient.onStatusChange((s) => {
            if (s === 'connected') { unsub(); requestReplay(); }
        });
        return () => { cancelled = true; unsub(); };
    }, [sessionId]);

    // Auto-scroll to bottom only when not scrolled up
    useEffect(() => {
        if (!showScrollBtn) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [items, thinking, showScrollBtn]);

    useEffect(() => {
        if (!drawerOpen) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [drawerOpen]);

    useEffect(() => {
        if (!drawerOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [drawerOpen]);

    const handleScroll = useCallback(() => {
        const el = messagesRef.current;
        if (!el) return;
        const scrollTop = el.scrollTop;
        const atBottom = el.scrollHeight - scrollTop - el.clientHeight < 120;
        const delta = scrollTop - lastScrollTopRef.current;
        lastScrollTopRef.current = scrollTop;

        setShowScrollBtn(!atBottom);

        // Mobile auto-hide: hide chrome while reading history (scroll up),
        // restore when scrolling back toward newest messages or reaching bottom.
        if (isTouchDevice) {
            if (atBottom || delta > 5) setChromeVisible(true);
            else if (delta < -5) setChromeVisible(false);
        }
    }, []);

    const activeSession = useMemo(() => sessions.find((s) => s.id === sessionId), [sessions, sessionId]);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        const el = inputRef.current;
        if (el) {
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 140) + 'px';
        }
    }, []);

    const handleSend = useCallback(() => {
        const text = input.trim();
        if (!text || status !== 'connected' || !sessionId) return;
        sessionClient.sendInput(sessionId, text);
        setInput('');
        setThinking(true);
        setItems(prev => [...prev, { kind: 'user', text, id: uid(), timestamp: Date.now() }]);
        const el = inputRef.current;
        if (el) el.style.height = 'auto';
        setTimeout(() => inputRef.current?.focus(), 0);
    }, [input, status, sessionId]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const handlePermission = useCallback((approved: boolean) => {
        if (!permission) return;
        sessionClient
            .rpc(uid(), 'session.permissionResponse', { sessionId, permissionId: permission.permissionId, approved })
            .catch(() => {});
        setPermission(null);
    }, [permission, sessionId]);

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

    const statusDot = status === 'connected' ? 'dot-green'
        : status === 'connecting' ? 'dot-orange'
        : status === 'error' ? 'dot-red'
        : 'dot-gray';
    const statusLabel = status === 'connected' ? '已连接'
        : status === 'connecting' ? '连接中…'
        : status === 'error' ? '错误'
        : '未连接';

    const placeholder = isTouchDevice ? '发消息…' : '发消息… (Enter 发送)';

    return (
        <div className="chat-screen">
            <SessionSidebar
                activeSessionId={sessionId}
                drawerOpen={drawerOpen}
                onCloseDrawer={() => setDrawerOpen(false)}
            />
            <div
                className={`drawer-backdrop${drawerOpen ? ' open' : ''}`}
                onClick={() => setDrawerOpen(false)}
                aria-hidden="true"
            />

            <div className={`chat-main${chromeVisible ? '' : ' chrome-hidden'}`}>
                {/* Permission request */}
                <Modal
                    open={!!permission}
                    title="权限请求"
                    onClose={() => handlePermission(false)}
                    size="md"
                >
                    {permission && (
                        <div className="modal-body">
                            <p className="modal-tool">{permission.toolName}</p>
                            <pre className="modal-input">{JSON.stringify(permission.input, null, 2)}</pre>
                            <div className="modal-actions">
                                <button type="button" className="btn btn-danger" onClick={() => handlePermission(false)}>
                                    拒绝
                                </button>
                                <button type="button" className="btn btn-primary" onClick={() => handlePermission(true)}>
                                    允许
                                </button>
                            </div>
                        </div>
                    )}
                </Modal>

                {/* Logs viewer */}
                <Modal
                    open={logsOpen}
                    title="CLI Logs"
                    onClose={() => setLogsOpen(false)}
                    size="lg"
                    bare
                    ariaLabel="CLI Logs"
                >
                    <div className="logs-modal-card">
                        <div className="logs-header">
                            <div className="logs-title-group">
                                <div className="logs-title">CLI 日志</div>
                                {logPath && <div className="logs-path">{logPath}</div>}
                            </div>
                            <button type="button" className="icon-btn" onClick={() => setLogsOpen(false)} aria-label="关闭日志">
                                <X size={18} />
                            </button>
                        </div>
                        <div className="logs-body">
                            {logsLoading
                                ? <div className="logs-loading">加载中…</div>
                                : logLines.length === 0
                                    ? <div className="logs-empty">暂无日志。</div>
                                    : logLines.map((line, i) => <div key={i} className="logs-line">{line}</div>)
                            }
                            <div ref={logsBottomRef} />
                        </div>
                    </div>
                </Modal>

                {/* IM-style header */}
                <div className="chat-header">
                    <div className="chat-header-left">
                        {/* Mobile: back to sessions list */}
                        <button
                            type="button"
                            className="icon-btn chat-back-btn"
                            onClick={() => navigate('/sessions')}
                            aria-label="返回会话列表"
                        >
                            <ChevronLeft size={22} />
                        </button>
                        {/* Desktop: hamburger menu for sidebar drawer */}
                        <button
                            type="button"
                            className="icon-btn chat-header-menu-btn"
                            onClick={() => setDrawerOpen(true)}
                            aria-label="打开会话列表"
                        >
                            ☰
                        </button>
                    </div>

                    <div className="chat-header-center">
                        {activeSession ? (
                            <>
                                <div className="chat-header-name">
                                    {activeSession.tool === 'claude' ? 'Claude' : 'Gemini'}
                                    {activeSession.model ? ` · ${activeSession.model}` : ''}
                                </div>
                                <div className="chat-header-sub">
                                    <span className={`status-dot ${statusDot}`} aria-hidden="true" />
                                    <span>{statusLabel}</span>
                                </div>
                            </>
                        ) : (
                            <div className="chat-header-name">Cowork</div>
                        )}
                    </div>

                    <div className="chat-header-actions">
                        {status === 'connected' && (
                            <button
                                type="button"
                                className="icon-btn"
                                onClick={handleOpenLogs}
                                aria-label="查看日志"
                                title="查看日志"
                            >
                                <ScrollText size={20} />
                            </button>
                        )}
                        <button
                            type="button"
                            className="icon-btn"
                            aria-label="更多操作"
                            title="更多操作"
                        >
                            <EllipsisVertical size={20} />
                        </button>
                    </div>
                </div>

                <div
                    className="chat-messages"
                    ref={messagesRef}
                    onScroll={handleScroll}
                    onClick={() => { if (!chromeVisible) setChromeVisible(true); }}
                >
                    {items.length === 0 && !thinking && (
                        <div className="chat-empty">
                            {status === 'connected' ? '今天想聊什么？' : '等待连接…'}
                        </div>
                    )}
                    {items.map(item => <MessageItem key={item.id} item={item} />)}
                    {thinking && <TypingDots />}
                    <div ref={bottomRef} />
                </div>

                {/* Scroll-to-bottom FAB */}
                <button
                    type="button"
                    className={`chat-fab${showScrollBtn ? '' : ' hidden'}`}
                    onClick={() => {
                        setShowScrollBtn(false);
                        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
                    }}
                    aria-label="滚动到底部"
                >
                    <ChevronDown size={20} />
                </button>

                {/* Input bar */}
                <div className="chat-input-bar">
                    <button
                        type="button"
                        className="icon-btn chat-input-extra"
                        aria-label="附件"
                        disabled={status !== 'connected' || thinking}
                    >
                        <Plus size={22} />
                    </button>
                    <div className="chat-input-wrap">
                        <textarea
                            ref={inputRef}
                            className="chat-textarea"
                            value={input}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            onFocus={() => setChromeVisible(true)}
                            placeholder={placeholder}
                            rows={1}
                            disabled={status !== 'connected' || thinking || !sessionId}
                        />
                    </div>
                    <button
                        type="button"
                        className={`chat-send-btn${input.trim() ? ' active' : ''}`}
                        onClick={handleSend}
                        disabled={!input.trim() || status !== 'connected' || thinking || !sessionId}
                        aria-label="发送消息"
                    >
                        <SendHorizontal size={18} />
                    </button>
                </div>
            </div>
        </div>
    );
}

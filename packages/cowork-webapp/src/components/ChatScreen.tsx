import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { directSocket, type SocketStatus, clearCredentials } from '../directSocket';
import { MarkdownMessage } from './MarkdownMessage';

// ── Event types ───────────────────────────────────────────────────────────────

interface TextPart { type: 'text'; text: string; }
interface ToolUsePart { type: 'tool_use'; id: string; name: string; input: unknown; }
interface ToolResultPart { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; }
type ContentPart = TextPart | ToolUsePart | ToolResultPart;

interface AssistantEvent { type: 'assistant'; message: { role: 'assistant'; content: ContentPart[] }; }
interface UserEvent { type: 'user'; message: { role: 'user'; content: string | ContentPart[] }; }
interface ResultEvent { type: 'result'; subtype: 'success' | 'error'; result: string; }
interface SystemEvent { type: 'system'; subtype: string; session_id?: string; }
interface PermissionEvent { type: 'permission-request'; permissionId: string; toolName: string; input: unknown; }
type ClaudeEvent = AssistantEvent | UserEvent | ResultEvent | SystemEvent | PermissionEvent | { type: string };

// ── Display items ─────────────────────────────────────────────────────────────

type Item =
    | { kind: 'user'; text: string; id: string }
    | { kind: 'assistant'; text: string; id: string }
    | { kind: 'tools'; names: string[]; id: string }
    | { kind: 'result'; text: string; success: boolean; id: string }
    | { kind: 'status'; text: string; id: string };

let counter = 0;
const uid = () => String(++counter);

function eventToItems(event: ClaudeEvent): Item[] {
    switch (event.type) {
        case 'user': {
            const e = event as UserEvent;
            const text = typeof e.message.content === 'string'
                ? e.message.content
                : (e.message.content.find((p): p is TextPart => p.type === 'text')?.text ?? '');
            return text ? [{ kind: 'user', text, id: uid() }] : [];
        }
        case 'assistant': {
            const e = event as AssistantEvent;
            const items: Item[] = [];
            const text = e.message.content.filter((p): p is TextPart => p.type === 'text').map(p => p.text).join('');
            if (text) items.push({ kind: 'assistant', text, id: uid() });
            const tools = e.message.content.filter((p): p is ToolUsePart => p.type === 'tool_use').map(p => p.name);
            if (tools.length) items.push({ kind: 'tools', names: tools, id: uid() });
            return items;
        }
        case 'result': {
            const e = event as ResultEvent;
            return e.subtype === 'error' ? [{ kind: 'result', text: e.result || 'error', success: false, id: uid() }] : [];
        }
        case 'system': {
            const e = event as SystemEvent;
            return e.session_id ? [{ kind: 'status', text: `Session ${e.session_id.slice(0, 8)}…`, id: uid() }] : [];
        }
        default: return [];
    }
}

// ── Sub-components ────────────────────────────────────────────────────────────

const ToolsItem = memo(function ToolsItem({ names }: { names: string[] }) {
    const [open, setOpen] = useState(false);
    const label = names.length === 1 ? names[0] : `${names.length} tool calls`;
    return (
        <button className="tools-group" onClick={() => setOpen(o => !o)}>
            <span className="tools-icon">⚙</span>
            <span className="tools-label">{label}</span>
            <span className="tools-chevron">{open ? '▾' : '▸'}</span>
            {open && names.length > 1 && (
                <ul className="tools-list">
                    {names.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
            )}
        </button>
    );
});

const MessageItem = memo(function MessageItem({ item }: { item: Item }) {
    switch (item.kind) {
        case 'user':
            return <div className="msg-user"><div className="msg-user-bubble">{item.text}</div></div>;
        case 'assistant':
            return <div className="msg-assistant"><MarkdownMessage text={item.text} /></div>;
        case 'tools':
            return <div className="msg-tools"><ToolsItem names={item.names} /></div>;
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
    const [status, setStatus] = useState<SocketStatus>(directSocket.getStatus());
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

    useEffect(() => {
        const unsubStatus = directSocket.onStatusChange(setStatus);
        const unsubMsg = directSocket.onMessage((payload) => {
            if ((payload as PermissionEvent).type === 'permission-request') {
                setPermission(payload as PermissionEvent);
                return;
            }
            const event = payload as ClaudeEvent;
            if (event.type === 'result') setThinking(false);
            const newItems = eventToItems(event);
            if (!newItems.length) return;
            setItems(prev => {
                const merged = [...prev];
                for (const item of newItems) {
                    if (item.kind === 'tools') {
                        const last = merged[merged.length - 1];
                        if (last?.kind === 'tools') { merged[merged.length - 1] = { ...last, names: [...last.names, ...item.names] }; continue; }
                    }
                    if (item.kind === 'user') {
                        const last = merged[merged.length - 1];
                        if (last?.kind === 'user' && last.text === item.text) continue;
                    }
                    merged.push(item);
                }
                return merged;
            });
        });

        if (directSocket.getStatus() === 'connected') {
            directSocket.rpc(uid(), 'replay', { fromSeq: -1 }).catch(() => {});
        }

        return () => { unsubStatus(); unsubMsg(); };
    }, []);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [items, thinking]);

    const handleSend = useCallback(() => {
        const text = input.trim();
        if (!text || status !== 'connected') return;
        directSocket.sendInput(text);
        setInput('');
        setThinking(true);
        setItems(prev => [...prev, { kind: 'user', text, id: uid() }]);
        setTimeout(() => inputRef.current?.focus(), 0);
    }, [input, status]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const handlePermission = useCallback((approved: boolean) => {
        if (!permission) return;
        directSocket.rpc(uid(), 'permissionResponse', { permissionId: permission.permissionId, approved }).catch(() => {});
        setPermission(null);
    }, [permission]);

    const handleBackToHome = useCallback(() => {
        navigate('/');
    }, [navigate]);

    const handleDisconnect = useCallback(() => {
        directSocket.disconnect();
        clearCredentials();
        navigate('/');
    }, [navigate]);

    const handleOpenLogs = useCallback(async () => {
        setLogsOpen(true);
        setLogsLoading(true);
        try {
            const res = await directSocket.rpc(uid(), 'getLogs', { lines: 300 });
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
                    {status === 'error' && directSocket.getLastError() && (
                        <span className="status-error-hint">{directSocket.getLastError()}</span>
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
                        disabled={status !== 'connected' || thinking}
                    />
                    <button
                        className="chat-send-btn"
                        onClick={handleSend}
                        disabled={!input.trim() || status !== 'connected' || thinking}
                    >
                        ↑
                    </button>
                </div>
            </div>
        </div>
    );
}

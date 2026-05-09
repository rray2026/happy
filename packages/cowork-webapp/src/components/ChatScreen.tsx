import { useState, useEffect, useRef, useCallback, memo, useMemo, useSyncExternalStore, useLayoutEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ScrollText, EllipsisVertical, Plus, SendHorizontal, ChevronDown, Square, Mic, Headphones } from 'lucide-react';
import { sessionClient } from '../session';
import type { Item, PermissionEvent, ToolCall } from '../types';
import { uid } from '../session/events';
import { useNames } from '../session/nameStore';
import { defaultName } from '../session/displayHelpers';
import { useEscape, useScrollLock } from '../hooks/overlay';
import { useSessions, useStatus } from '../hooks/session';
import { useSpeechRecognition } from '../hooks/voice';
import { useVoiceMode } from '../hooks/voiceMode';
import { VoiceModeBar } from './VoiceModeBar';
import { VoiceLiveTranscript } from './VoiceLiveTranscript';
import { VoiceStopButton } from './VoiceStopButton';
import { clearDraft, getDraft, setDraft } from '../session/draftStore';
import { SETTINGS_DEFAULTS, useSettings } from '../session/settingsStore';
import { dismissToast, showToast } from '../toast/toastStore';
import { MarkdownMessage } from './MarkdownMessage';
import { SessionSidebar } from './SessionSidebar';
import { Modal } from './Modal';
import { LogsModal } from './LogsModal';
import { summarizeToolCall } from './ToolCallView';

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

// ── Sub-components ────────────────────────────────────────────────────────────

const ToolsItem = memo(function ToolsItem({ calls }: { calls: ToolCall[] }) {
    const [open, setOpen] = useState(false);
    // Always render the latest call's per-tool summary in the header so the
    // user sees what's currently happening at a glance. When multiple calls
    // share this group, append a count so the total is also visible.
    const latest = calls[calls.length - 1];
    const latestSummary = latest ? summarizeToolCall(latest) : null;
    return (
        <div className="tools-group">
            <button
                type="button"
                className="tools-header"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
            >
                {latestSummary && (
                    <>
                        <span className="tools-name">{latest.name}</span>
                        <span className="tools-primary">{latestSummary.primary}</span>
                    </>
                )}
                {calls.length > 1 && (
                    <span className="tools-count">共 {calls.length} 个</span>
                )}
                <span className="tools-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
                <ul className="tools-list">
                    {calls.map((call) => {
                        const s = summarizeToolCall(call);
                        return (
                            <li key={call.toolUseId} className="tools-item">
                                <div className="tools-item-head">
                                    <span className="tools-item-name">{call.name}</span>
                                    <span className="tools-item-primary">{s.primary}</span>
                                </div>
                                {s.body && <div className="tools-item-body">{s.body}</div>}
                            </li>
                        );
                    })}
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
                        <MarkdownMessage text={item.text} streaming={item.streaming} />
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

    const status = useStatus();
    const sessions = useSessions();
    // Per-session items + pending permission read straight from the client's
    // cache; useSyncExternalStore re-binds when sessionId changes, so this
    // ChatScreen can keep mounted across session switches without a flash of
    // stale content.
    const items = useSyncExternalStore<Item[]>(
        useCallback((cb) => sessionClient.onItemsChange(sessionId, cb), [sessionId]),
        useCallback(() => sessionClient.getItems(sessionId), [sessionId]),
    );
    const permission = useSyncExternalStore<PermissionEvent | null>(
        useCallback((cb) => sessionClient.onPermissionChange(sessionId, cb), [sessionId]),
        useCallback(() => sessionClient.getPendingPermission(sessionId), [sessionId]),
    );
    const [input, setInput] = useState('');
    const [logsOpen, setLogsOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const messagesRef = useRef<HTMLDivElement>(null);
    const chatMainRef = useRef<HTMLDivElement>(null);
    const fabRef = useRef<HTMLButtonElement>(null);
    const lastScrollTopRef = useRef(0);
    // Visible/hidden flags ride on refs + classList instead of React state so
    // a fast scroll wheel never triggers a render. Public setters mirror to
    // the DOM.
    const chromeHiddenRef = useRef(false);
    const setChromeHidden = useCallback((hidden: boolean) => {
        if (chromeHiddenRef.current === hidden) return;
        chromeHiddenRef.current = hidden;
        chatMainRef.current?.classList.toggle('chrome-hidden', hidden);
    }, []);
    const atBottomRef = useRef(true);
    const setShowScrollBtn = useCallback((show: boolean) => {
        atBottomRef.current = !show;
        fabRef.current?.classList.toggle('hidden', !show);
    }, []);

    // Reset local UI state when the user switches sessions. The items and
    // permission caches re-bind via useSyncExternalStore above, but per-screen
    // ephemera (input draft, open menu/drawer, scroll position, chrome
    // visibility) belong to the previous session.
    // The ESLint rule discourages setState in an effect — fair as a default,
    // but this is the documented escape hatch for "reset child state when a
    // prop key would otherwise change," now that we've dropped key={sessionId}.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        // Restore any draft the user left in this session — never the
        // previous session's text.
        setInput(getDraft(sessionId));
        setDrawerOpen(false);
        setMenuOpen(false);
        setLogsOpen(false);
        setDeleteConfirmOpen(false);
        lastScrollTopRef.current = 0;
        setChromeHidden(false);
        setShowScrollBtn(false);
        atBottomRef.current = true;
        // If a permission toast for this session was raised before the user
        // got here, the modal we render below now owns the prompt — drop it.
        dismissToast(`perm-${sessionId}`);
    }, [sessionId, setChromeHidden, setShowScrollBtn]);
    /* eslint-enable react-hooks/set-state-in-effect */

    // Persist the current draft to localStorage with a small debounce so a
    // refresh / accidental close doesn't lose half-typed messages.
    useEffect(() => {
        const handle = setTimeout(() => setDraft(sessionId, input), 300);
        return () => clearTimeout(handle);
    }, [sessionId, input]);

    // Auto-scroll to bottom only when not scrolled up. The atBottomRef gets
    // updated in handleScroll without triggering a render.
    useEffect(() => {
        if (atBottomRef.current) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [items]);

    useScrollLock(drawerOpen);
    useEscape(drawerOpen, () => setDrawerOpen(false));

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
            if (atBottom || delta > 5) setChromeHidden(false);
            else if (delta < -5) setChromeHidden(true);
        }
    }, [setShowScrollBtn, setChromeHidden]);

    const activeSession = useMemo(() => sessions.find((s) => s.id === sessionId), [sessions, sessionId]);
    const isBusy = activeSession?.busy ?? false;
    const pendingCount = activeSession?.pending ?? 0;
    const names = useNames();
    const headerName = activeSession ? (names[sessionId] ?? defaultName(activeSession)) : 'Cowork';

    // Auto-grow the textarea whenever `input` changes, regardless of source
    // (typing, voice transcript, draft restore).
    useLayoutEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    }, [input]);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
    }, []);

    const handleSend = useCallback(() => {
        const text = input.trim();
        if (!text || status !== 'connected' || !sessionId) return;
        sessionClient.sendInput(sessionId, text);
        sessionClient.appendOptimisticUser(sessionId, text);
        setInput('');
        clearDraft(sessionId);
        setTimeout(() => inputRef.current?.focus(), 0);
    }, [input, status, sessionId]);

    // Voice dictation: appends transcribed words to the input box. We hold a
    // "baseline" snapshot of whatever the user had typed before pressing the
    // mic, plus refs for the running final + interim text, and recompute the
    // visible value on every result.
    const voiceBaselineRef = useRef('');
    const voiceFinalRef = useRef('');
    const voiceInterimRef = useRef('');
    const composeVoiceInput = useCallback(() => {
        const parts = [voiceBaselineRef.current, voiceFinalRef.current, voiceInterimRef.current]
            .map((p) => p.trim())
            .filter(Boolean);
        return parts.join(' ');
    }, []);
    const settings = useSettings();
    // Hands-free voice loop. Listens / sends / reads back / re-listens for
    // the active session; suspended whenever the user is typing or a
    // permission request is awaiting their click.
    const voiceMode = useVoiceMode({
        sessionId,
        items,
        isBusy,
        hasInput: input.trim().length > 0,
        hasPermission: !!permission,
        voiceLang: settings.voiceLang || undefined,
        ttsVoice: settings.ttsVoice || undefined,
        ttsRate: settings.ttsRate ?? SETTINGS_DEFAULTS.ttsRate,
        silenceMs: settings.silenceMs ?? SETTINGS_DEFAULTS.silenceMs,
        sendTrigger: settings.sendTrigger || undefined,
        stopReadingTrigger: settings.stopReadingTrigger || undefined,
        abortTrigger: settings.abortTrigger || undefined,
        cancelTrigger: settings.cancelTrigger || undefined,
        skipCode: settings.skipCode ?? SETTINGS_DEFAULTS.skipCode,
        toolCue: settings.toolCue ?? SETTINGS_DEFAULTS.toolCue,
        onError: (msg) => showToast(`语音模式：${msg}`, { kind: 'error' }),
    });

    const speech = useSpeechRecognition({
        // Empty string means "auto" in the settings store; the hook's own
        // default already falls back to navigator.language.
        lang: settings.voiceLang || undefined,
        onTranscript: (text, final) => {
            if (final) {
                voiceFinalRef.current = (voiceFinalRef.current + ' ' + text).trim();
                voiceInterimRef.current = '';
            } else {
                voiceInterimRef.current = text;
            }
            setInput(composeVoiceInput());
        },
        onError: (msg) => showToast(`语音输入：${msg}`, { kind: 'error' }),
    });

    const handleVoiceToggle = useCallback(() => {
        if (speech.listening) {
            speech.stop();
            // Drop any pending interim that hadn't been finalised; commit the
            // accumulated final text into the input as the new baseline so
            // further typing extends it normally.
            voiceInterimRef.current = '';
            voiceBaselineRef.current = composeVoiceInput();
            voiceFinalRef.current = '';
            setInput(voiceBaselineRef.current);
        } else {
            voiceBaselineRef.current = input;
            voiceFinalRef.current = '';
            voiceInterimRef.current = '';
            speech.start();
        }
    }, [speech, input, composeVoiceInput]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const handleAbort = useCallback(() => {
        if (!sessionId) return;
        sessionClient
            .rpc(uid(), 'session.abort', { sessionId })
            .catch((e: unknown) =>
                showToast(`中断失败：${e instanceof Error ? e.message : String(e)}`, { kind: 'error' }),
            );
    }, [sessionId]);

    const handlePermission = useCallback((approved: boolean) => {
        if (!permission) return;
        sessionClient
            .rpc(uid(), 'session.permissionResponse', { sessionId, permissionId: permission.permissionId, approved })
            .catch((e: unknown) =>
                showToast(`回应权限请求失败：${e instanceof Error ? e.message : String(e)}`, { kind: 'error' }),
            );
        sessionClient.clearPendingPermission(sessionId);
    }, [permission, sessionId]);

    const handleDeleteSession = useCallback(async () => {
        setDeleting(true);
        try {
            const res = await sessionClient.rpc(uid(), 'session.close', { sessionId });
            if (res.error) {
                showToast(`删除失败：${res.error}`, { kind: 'error' });
                setDeleting(false);
                return;
            }
        } catch (e) {
            showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
            setDeleting(false);
            return;
        }
        setDeleting(false);
        setDeleteConfirmOpen(false);
        navigate('/sessions');
    }, [sessionId, navigate]);

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

            <div ref={chatMainRef} className={`chat-main${voiceMode.active ? ' voice-mode-active' : ''}`}>
                {/* Delete confirmation */}
                <Modal
                    open={deleteConfirmOpen}
                    title="删除会话"
                    onClose={() => setDeleteConfirmOpen(false)}
                    size="md"
                >
                    <div className="modal-body">
                        <p style={{ margin: 0 }}>确定要删除这个会话吗？历史记录将一并清除，无法恢复。</p>
                        <div className="modal-actions">
                            <button type="button" className="btn btn-secondary" onClick={() => setDeleteConfirmOpen(false)} disabled={deleting}>
                                取消
                            </button>
                            <button type="button" className="btn btn-danger" onClick={handleDeleteSession} disabled={deleting}>
                                {deleting ? '删除中…' : '删除'}
                            </button>
                        </div>
                    </div>
                </Modal>

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

                <LogsModal open={logsOpen} onClose={() => setLogsOpen(false)} />

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
                        <div className="chat-header-name">{headerName}</div>
                        {activeSession && (
                            <div className="chat-header-sub">
                                <span className={`status-dot ${statusDot}`} aria-hidden="true" />
                                <span>{statusLabel}</span>
                            </div>
                        )}
                    </div>

                    <div className="chat-header-actions">
                        {voiceMode.supported && (
                            <button
                                type="button"
                                className={`icon-btn voice-toggle${voiceMode.active && voiceMode.mode === 'input' ? ' active' : ''}${voiceMode.active && voiceMode.mode === 'input' && voiceMode.suspended ? ' suspended' : ''}`}
                                onClick={() => voiceMode.toggleMode('input')}
                                aria-label={voiceMode.active && voiceMode.mode === 'input' ? '关闭语音输入' : '开启语音输入'}
                                aria-pressed={voiceMode.active && voiceMode.mode === 'input'}
                                title={
                                    voiceMode.active && voiceMode.mode === 'input'
                                        ? '关闭语音输入'
                                        : voiceMode.active
                                            ? '请先关闭语音模式'
                                            : '开启语音输入（连续听写，无朗读）'
                                }
                                disabled={voiceMode.active && voiceMode.mode !== 'input'}
                            >
                                <Mic size={20} />
                            </button>
                        )}
                        {voiceMode.supported && voiceMode.ttsSupported && (
                            <button
                                type="button"
                                className={`icon-btn voice-toggle${voiceMode.active && voiceMode.mode === 'full' ? ' active' : ''}${voiceMode.active && voiceMode.mode === 'full' && voiceMode.suspended ? ' suspended' : ''}`}
                                onClick={() => voiceMode.toggleMode('full')}
                                aria-label={voiceMode.active && voiceMode.mode === 'full' ? '关闭语音模式' : '开启语音模式'}
                                aria-pressed={voiceMode.active && voiceMode.mode === 'full'}
                                title={
                                    voiceMode.active && voiceMode.mode === 'full'
                                        ? '关闭语音模式'
                                        : voiceMode.active
                                            ? '请先关闭语音输入'
                                            : '开启语音模式（连续听-说-读）'
                                }
                                disabled={voiceMode.active && voiceMode.mode !== 'full'}
                            >
                                <Headphones size={20} />
                            </button>
                        )}
                        {status === 'connected' && (
                            <button
                                type="button"
                                className="icon-btn"
                                onClick={() => setLogsOpen(true)}
                                aria-label="查看日志"
                                title="查看日志"
                            >
                                <ScrollText size={20} />
                            </button>
                        )}
                        <div className="chat-header-menu-wrap">
                            <button
                                type="button"
                                className="icon-btn"
                                aria-label="更多操作"
                                title="更多操作"
                                onClick={() => setMenuOpen((o) => !o)}
                            >
                                <EllipsisVertical size={20} />
                            </button>
                            {menuOpen && (
                                <>
                                    <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                                    <div className="chat-menu-dropdown">
                                        <button
                                            type="button"
                                            className="chat-menu-item chat-menu-item-danger"
                                            onClick={() => { setMenuOpen(false); setDeleteConfirmOpen(true); }}
                                        >
                                            删除会话
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {voiceMode.active && (
                    <VoiceModeBar
                        phase={voiceMode.phase}
                        suspended={voiceMode.suspended}
                    />
                )}
                <VoiceLiveTranscript
                    transcript={voiceMode.liveTranscript}
                    visible={
                        voiceMode.active &&
                        !voiceMode.suspended &&
                        (voiceMode.phase === 'listening' || voiceMode.phase === 'pending')
                    }
                    pending={voiceMode.phase === 'pending'}
                />


                <div
                    className="chat-messages"
                    ref={messagesRef}
                    onScroll={handleScroll}
                    onClick={() => setChromeHidden(false)}
                >
                    {items.length === 0 && !isBusy && (
                        <div className="chat-empty">
                            {status === 'connected' ? '今天想聊什么？' : '等待连接…'}
                        </div>
                    )}
                    {items.map(item => <MessageItem key={item.id} item={item} />)}
                    {isBusy && <TypingDots />}
                    <div ref={bottomRef} />
                </div>

                {/* Scroll-to-bottom FAB. Visibility is toggled imperatively
                 * via fabRef in handleScroll to avoid a render per scroll frame. */}
                <button
                    ref={fabRef}
                    type="button"
                    className="chat-fab hidden"
                    onClick={() => {
                        setShowScrollBtn(false);
                        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
                    }}
                    aria-label="滚动到底部"
                >
                    <ChevronDown size={20} />
                </button>

                <VoiceStopButton
                    visible={voiceMode.active && voiceMode.phase === 'speaking'}
                    onStop={voiceMode.stopReading}
                />

                {/* Pending-queue hint (only when prompts queued behind the in-flight turn) */}
                {pendingCount > 0 && (
                    <div className="chat-pending-hint" aria-live="polite">
                        {pendingCount} 条排队中
                    </div>
                )}

                {/* Input bar */}
                <div className="chat-input-bar">
                    <button
                        type="button"
                        className="icon-btn chat-input-extra"
                        aria-label="附件"
                        disabled={status !== 'connected'}
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
                            onFocus={() => setChromeHidden(false)}
                            placeholder={placeholder}
                            rows={1}
                            disabled={status !== 'connected' || !sessionId}
                        />
                    </div>
                    {speech.supported && !voiceMode.active && (
                        <button
                            type="button"
                            className={`chat-voice-btn${speech.listening ? ' listening' : ''}`}
                            onClick={handleVoiceToggle}
                            aria-label={speech.listening ? '停止语音输入' : '开始语音输入'}
                            aria-pressed={speech.listening}
                            title={speech.listening ? '停止语音输入' : '开始语音输入'}
                            disabled={status !== 'connected' || !sessionId}
                        >
                            <Mic size={18} />
                        </button>
                    )}
                    {isBusy ? (
                        <button
                            type="button"
                            className="chat-abort-btn"
                            onClick={handleAbort}
                            disabled={status !== 'connected' || !sessionId}
                            aria-label="中断"
                            title="中断当前回合"
                        >
                            <Square size={14} fill="currentColor" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className={`chat-send-btn${input.trim() ? ' active' : ''}`}
                            onClick={handleSend}
                            disabled={!input.trim() || status !== 'connected' || !sessionId}
                            aria-label="发送消息"
                        >
                            <SendHorizontal size={18} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

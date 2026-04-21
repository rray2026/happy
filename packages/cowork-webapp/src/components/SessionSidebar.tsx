import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionClient } from '../session';
import type { ChatSessionMeta } from '../types';
import { uid } from '../session/events';
import { Modal } from './Modal';

interface Props {
    activeSessionId: string | null;
    /** When true on mobile (≤768px), sidebar slides in from the left. */
    drawerOpen?: boolean;
    /** Called when the drawer should close (e.g. user picked an item). */
    onCloseDrawer?: () => void;
}

type PendingClose = { sessionId: string; label: string };

/**
 * Left-hand list of chat sessions on the current connection. Creates / closes
 * sessions via RPC; the list stays in sync through `sessionClient.onSessionsChange`.
 */
export function SessionSidebar({ activeSessionId, drawerOpen = false, onCloseDrawer }: Props) {
    const navigate = useNavigate();
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());
    const [creating, setCreating] = useState(false);
    const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
    const [createError, setCreateError] = useState<string | null>(null);

    useEffect(() => sessionClient.onSessionsChange(setSessions), []);

    const goto = useCallback((path: string) => {
        navigate(path);
        onCloseDrawer?.();
    }, [navigate, onCloseDrawer]);

    const handleCreate = useCallback(
        async (tool: 'claude' | 'gemini') => {
            setCreating(true);
            setCreateError(null);
            try {
                const res = await sessionClient.rpc(uid(), 'session.create', { tool });
                if (res.error) {
                    setCreateError(`无法创建会话：${res.error}`);
                    return;
                }
                const created = (res.result as { session?: ChatSessionMeta } | undefined)?.session;
                if (created) goto(`/chat/${created.id}`);
            } finally {
                setCreating(false);
            }
        },
        [goto],
    );

    const confirmClose = useCallback(async () => {
        if (!pendingClose) return;
        const { sessionId } = pendingClose;
        setPendingClose(null);
        await sessionClient.rpc(uid(), 'session.close', { sessionId });
        if (sessionId === activeSessionId) {
            const remaining = sessionClient.getSessions().filter((s) => s.id !== sessionId);
            goto(remaining[0] ? `/chat/${remaining[0].id}` : '/chat');
        }
    }, [pendingClose, activeSessionId, goto]);

    const requestClose = useCallback((s: ChatSessionMeta) => {
        setPendingClose({
            sessionId: s.id,
            label: `${s.tool} · ${s.id.slice(0, 8)}`,
        });
    }, []);

    return (
        <>
            <aside
                className={`session-sidebar${drawerOpen ? ' drawer-open' : ''}`}
                aria-label="会话列表"
            >
                <div className="sidebar-head">
                    <div className="sidebar-title">会话</div>
                    {onCloseDrawer && (
                        <button
                            type="button"
                            className="icon-btn chat-header-menu-btn"
                            onClick={onCloseDrawer}
                            aria-label="关闭会话列表"
                        >
                            ✕
                        </button>
                    )}
                </div>

                <div className="sidebar-list">
                    {sessions.length === 0 && (
                        <div className="sidebar-empty">暂无会话</div>
                    )}
                    {sessions.map((s) => (
                        <div
                            key={s.id}
                            className={`sidebar-item ${s.id === activeSessionId ? 'active' : ''}`}
                        >
                            <button
                                type="button"
                                className="sidebar-item-main"
                                onClick={() => goto(`/chat/${s.id}`)}
                            >
                                <span className={`sidebar-tool tool-${s.tool}`}>{s.tool}</span>
                                <span className="sidebar-id">{s.id.slice(0, 8)}</span>
                                {s.model && <span className="sidebar-model">{s.model}</span>}
                            </button>
                            <button
                                type="button"
                                className="sidebar-close"
                                onClick={() => requestClose(s)}
                                aria-label={`关闭会话 ${s.id.slice(0, 8)}`}
                                title="关闭会话"
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>

                <div className="sidebar-foot">
                    <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={creating}
                        onClick={() => handleCreate('claude')}
                    >
                        + Claude
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={creating}
                        onClick={() => handleCreate('gemini')}
                    >
                        + Gemini
                    </button>
                </div>
            </aside>

            <Modal
                open={!!pendingClose}
                title="关闭这个会话？"
                onClose={() => setPendingClose(null)}
                size="sm"
            >
                <div className="modal-body">
                    <p className="confirm-text">
                        对应的 AI 进程会被终止，未发送的消息会丢失。
                    </p>
                    {pendingClose && (
                        <p className="confirm-hint">{pendingClose.label}</p>
                    )}
                    <div className="modal-actions">
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setPendingClose(null)}
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            className="btn btn-danger"
                            onClick={confirmClose}
                        >
                            关闭会话
                        </button>
                    </div>
                </div>
            </Modal>

            <Modal
                open={!!createError}
                title="无法创建会话"
                onClose={() => setCreateError(null)}
                size="sm"
            >
                <div className="modal-body">
                    <p className="confirm-text">{createError}</p>
                    <div className="modal-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => setCreateError(null)}
                        >
                            好的
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}

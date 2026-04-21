import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionClient } from '../session';
import type { ChatSessionMeta } from '../types';
import { uid } from '../session/events';

interface Props {
    activeSessionId: string | null;
}

/**
 * Left-hand list of chat sessions on the current connection. Creates / closes
 * sessions via RPC; the list stays in sync through `sessionClient.onSessionsChange`.
 */
export function SessionSidebar({ activeSessionId }: Props) {
    const navigate = useNavigate();
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());
    const [creating, setCreating] = useState(false);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => sessionClient.onSessionsChange(setSessions), []);

    const handleCreate = useCallback(
        async (tool: 'claude' | 'gemini') => {
            setCreating(true);
            try {
                const res = await sessionClient.rpc(uid(), 'session.create', { tool });
                if (res.error) {
                    alert(`无法创建会话：${res.error}`);
                    return;
                }
                const created = (res.result as { session?: ChatSessionMeta } | undefined)?.session;
                if (created) navigate(`/chat/${created.id}`);
            } finally {
                setCreating(false);
            }
        },
        [navigate],
    );

    const handleClose = useCallback(
        async (sessionId: string) => {
            if (!confirm('关闭这个会话？对应的 AI 进程会被终止。')) return;
            await sessionClient.rpc(uid(), 'session.close', { sessionId });
            if (sessionId === activeSessionId) {
                const remaining = sessionClient.getSessions().filter((s) => s.id !== sessionId);
                navigate(remaining[0] ? `/chat/${remaining[0].id}` : '/chat');
            }
        },
        [activeSessionId, navigate],
    );

    if (collapsed) {
        return (
            <div className="session-sidebar collapsed">
                <button
                    className="sidebar-toggle"
                    onClick={() => setCollapsed(false)}
                    title="展开会话列表"
                >
                    ☰
                </button>
            </div>
        );
    }

    return (
        <div className="session-sidebar">
            <div className="sidebar-head">
                <div className="sidebar-title">会话</div>
                <button
                    className="sidebar-toggle"
                    onClick={() => setCollapsed(true)}
                    title="收起"
                >
                    ⟨
                </button>
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
                            className="sidebar-item-main"
                            onClick={() => navigate(`/chat/${s.id}`)}
                        >
                            <span className={`sidebar-tool tool-${s.tool}`}>{s.tool}</span>
                            <span className="sidebar-id">{s.id.slice(0, 8)}</span>
                            {s.model && <span className="sidebar-model">{s.model}</span>}
                        </button>
                        <button
                            className="sidebar-close"
                            onClick={() => handleClose(s.id)}
                            title="关闭会话"
                        >
                            ✕
                        </button>
                    </div>
                ))}
            </div>

            <div className="sidebar-foot">
                <button
                    className="sidebar-new"
                    disabled={creating}
                    onClick={() => handleCreate('claude')}
                >
                    + Claude
                </button>
                <button
                    className="sidebar-new"
                    disabled={creating}
                    onClick={() => handleCreate('gemini')}
                >
                    + Gemini
                </button>
            </div>
        </div>
    );
}

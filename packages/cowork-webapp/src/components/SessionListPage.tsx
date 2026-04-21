import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Bot } from 'lucide-react';
import { sessionClient } from '../session';
import type { ChatSessionMeta } from '../types';
import { NewSessionModal } from './NewSessionModal';

function formatTime(ms: number): string {
    const now = Date.now();
    const diff = now - ms;
    const d = new Date(ms);
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function SessionAvatar({ tool }: { tool: 'claude' | 'gemini' }) {
    return (
        <div className={`session-row-avatar avatar-${tool}`}>
            <Bot size={22} />
        </div>
    );
}

export function SessionListPage() {
    const navigate = useNavigate();
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());
    const [newSessionOpen, setNewSessionOpen] = useState(false);

    useEffect(() => sessionClient.onSessionsChange(setSessions), []);

    const handleSessionCreated = useCallback((s: ChatSessionMeta) => {
        navigate(`/sessions/${s.id}`);
    }, [navigate]);

    return (
        <div className="session-list-page tab-page">
            <div className="session-list-header">
                <h1 className="session-list-title">会话</h1>
                <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setNewSessionOpen(true)}
                    aria-label="新建会话"
                >
                    <Plus size={22} />
                </button>
            </div>

            <div className="session-list-body">
                {sessions.length === 0 ? (
                    <div className="session-list-empty">
                        <Bot size={40} className="session-list-empty-icon" />
                        <p>暂无会话</p>
                        <p className="session-list-empty-sub">点击右上角 + 新建会话</p>
                    </div>
                ) : (
                    sessions.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            className="session-row"
                            onClick={() => navigate(`/sessions/${s.id}`)}
                        >
                            <SessionAvatar tool={s.tool} />
                            <div className="session-row-content">
                                <div className="session-row-title-row">
                                    <span className="session-row-name">
                                        {s.tool === 'claude' ? 'Claude' : 'Gemini'}
                                        {s.model ? ` · ${s.model}` : ''}
                                    </span>
                                    <span className="session-row-time">{formatTime(s.createdAt)}</span>
                                </div>
                                <div className="session-row-sub">{s.cwd || s.id.slice(0, 12)}</div>
                            </div>
                        </button>
                    ))
                )}
            </div>

            <NewSessionModal
                open={newSessionOpen}
                onClose={() => setNewSessionOpen(false)}
                onCreated={handleSessionCreated}
            />
        </div>
    );
}

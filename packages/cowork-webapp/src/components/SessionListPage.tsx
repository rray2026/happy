import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Bot, Pencil } from 'lucide-react';
import { sessionClient } from '../session';
import type { ChatSessionMeta } from '../types';
import { NewSessionModal } from './NewSessionModal';
import { loadNames, saveName } from '../session/nameStore';

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

function defaultName(s: ChatSessionMeta): string {
    return (s.tool === 'claude' ? 'Claude' : 'Gemini') + (s.model ? ` · ${s.model}` : '');
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
    const [names, setNames] = useState<Record<string, string>>(loadNames);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingValue, setEditingValue] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => sessionClient.onSessionsChange(setSessions), []);

    useEffect(() => {
        if (editingId) inputRef.current?.focus();
    }, [editingId]);

    const handleSessionCreated = useCallback((s: ChatSessionMeta) => {
        navigate(`/sessions/${s.id}`);
    }, [navigate]);

    const startEdit = useCallback((s: ChatSessionMeta, e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingId(s.id);
        setEditingValue(names[s.id] ?? defaultName(s));
    }, [names]);

    const commitEdit = useCallback(() => {
        if (!editingId) return;
        saveName(editingId, editingValue);
        setNames(loadNames());
        setEditingId(null);
    }, [editingId, editingValue]);

    const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
        if (e.key === 'Escape') { setEditingId(null); }
    }, [commitEdit]);

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
                    sessions.map((s) => {
                        const isEditing = editingId === s.id;
                        const displayName = names[s.id] ?? defaultName(s);
                        return (
                            <div
                                key={s.id}
                                className={`session-row${isEditing ? ' session-row-editing' : ''}`}
                                onClick={() => !isEditing && navigate(`/sessions/${s.id}`)}
                            >
                                <SessionAvatar tool={s.tool} />
                                <div className="session-row-content">
                                    <div className="session-row-title-row">
                                        {isEditing ? (
                                            <input
                                                ref={inputRef}
                                                className="session-row-name-input"
                                                value={editingValue}
                                                onChange={e => setEditingValue(e.target.value)}
                                                onKeyDown={handleEditKeyDown}
                                                onBlur={commitEdit}
                                                onClick={e => e.stopPropagation()}
                                                maxLength={40}
                                            />
                                        ) : (
                                            <>
                                                <span className="session-row-name">{displayName}</span>
                                                <span className="session-row-time">{formatTime(s.createdAt)}</span>
                                            </>
                                        )}
                                    </div>
                                    <div className="session-row-sub">{s.cwd || s.id.slice(0, 12)}</div>
                                </div>
                                {!isEditing && (
                                    <button
                                        type="button"
                                        className="session-row-edit-btn"
                                        onClick={e => startEdit(s, e)}
                                        aria-label="重命名"
                                    >
                                        <Pencil size={14} />
                                    </button>
                                )}
                            </div>
                        );
                    })
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

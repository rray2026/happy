import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Bot, Pencil, RefreshCw, X } from 'lucide-react';
import { sessionClient } from '../session';
import type { ChatSessionMeta } from '../types';
import { NewSessionModal } from './NewSessionModal';
import { Modal } from './Modal';
import { uid } from '../session/events';
import { saveName, useNames } from '../session/nameStore';
import { busyLabel, defaultName, formatSessionTime } from '../session/displayHelpers';

function SessionAvatar({ tool }: { tool: 'claude' | 'gemini' }) {
    return (
        <div className={`session-row-avatar avatar-${tool}`}>
            <Bot size={22} />
        </div>
    );
}

type PendingClose = { sessionId: string; label: string };

export function SessionListPage() {
    const navigate = useNavigate();
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());
    const [newSessionOpen, setNewSessionOpen] = useState(false);
    const names = useNames();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingValue, setEditingValue] = useState('');
    const [refreshing, setRefreshing] = useState(false);
    const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => sessionClient.onSessionsChange(setSessions), []);

    // Defensive resync on mount: covers reconnect timing edge cases where the
    // cached list could be stale (e.g. user opens the list right after a
    // resume that raced with auto-reconnect).
    useEffect(() => {
        sessionClient.refreshSessions().catch(() => { /* ignore */ });
    }, []);

    const handleRefresh = useCallback(async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
            await sessionClient.refreshSessions();
        } catch {
            // Surfaced via the unchanged list — no toast plumbing here.
        } finally {
            setRefreshing(false);
        }
    }, [refreshing]);

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
        setEditingId(null);
    }, [editingId, editingValue]);

    const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
        if (e.key === 'Escape') { setEditingId(null); }
    }, [commitEdit]);

    const requestClose = useCallback((s: ChatSessionMeta, e: React.MouseEvent) => {
        e.stopPropagation();
        setPendingClose({ sessionId: s.id, label: names[s.id] ?? defaultName(s) });
    }, [names]);

    const confirmClose = useCallback(async () => {
        if (!pendingClose) return;
        const { sessionId } = pendingClose;
        setPendingClose(null);
        await sessionClient.rpc(uid(), 'session.close', { sessionId }).catch(() => {});
    }, [pendingClose]);

    return (
        <div className="session-list-page tab-page">
            <div className="session-list-header">
                <h1 className="session-list-title">会话</h1>
                <div className="session-list-header-actions">
                    <button
                        type="button"
                        className="icon-btn"
                        onClick={handleRefresh}
                        disabled={refreshing}
                        aria-label="刷新会话列表"
                    >
                        <RefreshCw size={20} className={refreshing ? 'icon-spin' : undefined} />
                    </button>
                    <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setNewSessionOpen(true)}
                        aria-label="新建会话"
                    >
                        <Plus size={22} />
                    </button>
                </div>
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
                        const name = names[s.id] ?? defaultName(s);
                        const busy = busyLabel(s);
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
                                                <span className="session-row-name">{name}</span>
                                                <span className="session-row-time">{formatSessionTime(s.createdAt)}</span>
                                            </>
                                        )}
                                    </div>
                                    <div className="session-row-sub">
                                        {busy ? (
                                            <span className="session-row-busy">
                                                <span className="session-row-busy-dot" aria-hidden="true" />
                                                {busy}
                                            </span>
                                        ) : (
                                            s.cwd || s.id.slice(0, 12)
                                        )}
                                    </div>
                                </div>
                                {!isEditing && (
                                    <div className="session-row-actions">
                                        <button
                                            type="button"
                                            className="session-row-icon-btn"
                                            onClick={(e) => startEdit(s, e)}
                                            aria-label="重命名"
                                            title="重命名"
                                        >
                                            <Pencil size={14} />
                                        </button>
                                        <button
                                            type="button"
                                            className="session-row-icon-btn session-row-icon-btn-danger"
                                            onClick={(e) => requestClose(s, e)}
                                            aria-label="关闭会话"
                                            title="关闭会话"
                                        >
                                            <X size={14} />
                                        </button>
                                    </div>
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
                        <button type="button" className="btn btn-secondary" onClick={() => setPendingClose(null)}>
                            取消
                        </button>
                        <button type="button" className="btn btn-danger" onClick={confirmClose}>
                            关闭会话
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}

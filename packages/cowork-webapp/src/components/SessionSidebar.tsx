import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Plus, X } from 'lucide-react';
import { sessionClient } from '../session';
import type { ChatSessionMeta } from '../types';
import { uid } from '../session/events';
import { saveName, useNames } from '../session/nameStore';
import { busyLabel, defaultName } from '../session/displayHelpers';
import { Modal } from './Modal';
import { NewSessionModal } from './NewSessionModal';

interface Props {
    activeSessionId: string | null;
    drawerOpen?: boolean;
    onCloseDrawer?: () => void;
}

type PendingClose = { sessionId: string; label: string };

export function SessionSidebar({ activeSessionId, drawerOpen = false, onCloseDrawer }: Props) {
    const navigate = useNavigate();
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());
    const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
    const [newSessionOpen, setNewSessionOpen] = useState(false);
    const names = useNames();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingValue, setEditingValue] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => sessionClient.onSessionsChange(setSessions), []);

    useEffect(() => {
        if (editingId) inputRef.current?.focus();
    }, [editingId]);

    const goto = useCallback((path: string) => {
        navigate(path);
        onCloseDrawer?.();
    }, [navigate, onCloseDrawer]);

    const handleSessionCreated = useCallback(
        (s: ChatSessionMeta) => { goto(`/sessions/${s.id}`); },
        [goto],
    );

    const confirmClose = useCallback(async () => {
        if (!pendingClose) return;
        const { sessionId } = pendingClose;
        setPendingClose(null);
        await sessionClient.rpc(uid(), 'session.close', { sessionId });
        if (sessionId === activeSessionId) {
            const remaining = sessionClient.getSessions().filter((s) => s.id !== sessionId);
            goto(remaining[0] ? `/sessions/${remaining[0].id}` : '/sessions');
        }
    }, [pendingClose, activeSessionId, goto]);

    const requestClose = useCallback((s: ChatSessionMeta, e: React.MouseEvent) => {
        e.stopPropagation();
        setPendingClose({ sessionId: s.id, label: names[s.id] ?? defaultName(s) });
    }, [names]);

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
                            className="icon-btn"
                            onClick={onCloseDrawer}
                            aria-label="关闭会话列表"
                        >
                            <X size={18} />
                        </button>
                    )}
                </div>

                <div className="sidebar-list">
                    {sessions.length === 0 && (
                        <div className="sidebar-empty">暂无会话</div>
                    )}
                    {sessions.map((s) => {
                        const isEditing = editingId === s.id;
                        const name = names[s.id] ?? defaultName(s);
                        const busy = busyLabel(s);
                        return (
                            <div
                                key={s.id}
                                className={`sidebar-item${s.id === activeSessionId ? ' active' : ''}${isEditing ? ' sidebar-item-editing' : ''}`}
                            >
                                <button
                                    type="button"
                                    className="sidebar-item-main"
                                    onClick={() => !isEditing && goto(`/sessions/${s.id}`)}
                                >
                                    <span className={`sidebar-tool tool-${s.tool}`}>{s.tool}</span>
                                    {isEditing ? (
                                        <input
                                            ref={inputRef}
                                            className="sidebar-name-input"
                                            value={editingValue}
                                            onChange={e => setEditingValue(e.target.value)}
                                            onKeyDown={handleEditKeyDown}
                                            onBlur={commitEdit}
                                            onClick={e => e.stopPropagation()}
                                            maxLength={40}
                                        />
                                    ) : (
                                        <span className="sidebar-name">{name}</span>
                                    )}
                                    {busy && !isEditing && (
                                        <span className="sidebar-busy-dot" aria-label="运行中" title={busy} />
                                    )}
                                </button>
                                {!isEditing && (
                                    <div className="sidebar-actions">
                                        <button
                                            type="button"
                                            className="sidebar-action-btn"
                                            onClick={(e) => startEdit(s, e)}
                                            aria-label={`重命名 ${name}`}
                                            title="重命名"
                                        >
                                            <Pencil size={12} />
                                        </button>
                                        <button
                                            type="button"
                                            className="sidebar-action-btn sidebar-action-btn-danger"
                                            onClick={(e) => requestClose(s, e)}
                                            aria-label={`关闭会话 ${name}`}
                                            title="关闭会话"
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                <div className="sidebar-foot">
                    <button
                        type="button"
                        className="btn btn-primary btn-block"
                        onClick={() => setNewSessionOpen(true)}
                    >
                        <Plus size={16} />
                        新建会话
                    </button>
                </div>
            </aside>

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
        </>
    );
}

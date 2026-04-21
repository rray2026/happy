import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, Plus } from 'lucide-react';
import { sessionClient } from '../session';
import type { ChatSessionMeta, SocketStatus } from '../types';
import { NewSessionModal } from './NewSessionModal';

export function HomePage() {
    const navigate = useNavigate();
    const [status, setStatus] = useState<SocketStatus>(sessionClient.getStatus());
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());
    const [newSessionOpen, setNewSessionOpen] = useState(false);

    useEffect(() => sessionClient.onStatusChange(setStatus), []);
    useEffect(() => sessionClient.onSessionsChange(setSessions), []);

    const handleResume = () => {
        const last = sessions[sessions.length - 1];
        navigate(last ? `/sessions/${last.id}` : '/sessions');
    };

    const handleSessionCreated = useCallback((s: ChatSessionMeta) => {
        navigate(`/sessions/${s.id}`);
    }, [navigate]);

    const statusDot = status === 'connected' ? 'dot-green'
        : status === 'connecting' ? 'dot-orange'
        : status === 'error' ? 'dot-red'
        : 'dot-gray';

    const connected = status === 'connected';

    return (
        <div className="home-page tab-page">
            <div className="home-content">
                <div className="home-logo">⚡</div>
                <h1 className="home-title">Cowork</h1>
                <div className="home-status">
                    <span className={`status-dot ${statusDot}`} aria-hidden="true" />
                    <span className="home-status-label">
                        {status === 'connected' ? '已连接'
                            : status === 'connecting' ? '连接中…'
                            : status === 'error' ? '连接错误'
                            : '未连接'}
                    </span>
                </div>

                <div className="home-actions">
                    <button
                        type="button"
                        className="home-action-btn"
                        onClick={handleResume}
                        disabled={!connected || sessions.length === 0}
                    >
                        <MessageSquare size={22} className="home-action-icon" />
                        <span className="home-action-label">回到会话</span>
                        {sessions.length > 0 && (
                            <span className="home-action-badge">{sessions.length}</span>
                        )}
                    </button>

                    <button
                        type="button"
                        className="home-action-btn"
                        onClick={() => setNewSessionOpen(true)}
                        disabled={!connected}
                    >
                        <Plus size={22} className="home-action-icon" />
                        <span className="home-action-label">新建会话</span>
                    </button>
                </div>
            </div>

            <NewSessionModal
                open={newSessionOpen}
                onClose={() => setNewSessionOpen(false)}
                onCreated={handleSessionCreated}
            />
        </div>
    );
}

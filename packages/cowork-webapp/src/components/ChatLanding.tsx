import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { sessionClient } from '../session';
import type { ChatSessionMeta, SocketStatus } from '../types';
import { SessionSidebar } from './SessionSidebar';
import { NewSessionModal } from './NewSessionModal';

/**
 * Entry point for /chat. If the connection already has at least one session,
 * redirect to it immediately; otherwise show a "create your first session"
 * affordance that opens the NewSessionModal.
 */
export function ChatLanding() {
    const navigate = useNavigate();
    const [status, setStatus] = useState<SocketStatus>(sessionClient.getStatus());
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());
    const [modalOpen, setModalOpen] = useState(false);

    useEffect(() => {
        const unsubStatus = sessionClient.onStatusChange(setStatus);
        const unsubSessions = sessionClient.onSessionsChange(setSessions);
        return () => {
            unsubStatus();
            unsubSessions();
        };
    }, []);

    if (status === 'disconnected' && !sessionClient.loadStoredCredentials()) {
        return <Navigate to="/" replace />;
    }

    if (sessions.length > 0) {
        return <Navigate to={`/chat/${sessions[0].id}`} replace />;
    }

    return (
        <div className="chat-screen">
            <SessionSidebar activeSessionId={null} />
            <div className="chat-empty-pane">
                <div className="chat-empty-box">
                    <div className="chat-empty-title">还没有会话</div>
                    <div className="chat-empty-sub">
                        为当前连接创建第一个会话，并选择它的工作目录
                        （默认为 agent 进程启动时所在的目录）。
                    </div>
                    <div className="chat-empty-actions">
                        <button
                            type="button"
                            className="btn btn-primary btn-lg"
                            disabled={status !== 'connected'}
                            onClick={() => setModalOpen(true)}
                        >
                            + 新建会话
                        </button>
                    </div>
                </div>
            </div>

            <NewSessionModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onCreated={(s) => navigate(`/chat/${s.id}`)}
            />
        </div>
    );
}

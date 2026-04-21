import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { sessionClient } from '../session';
import type { ChatSessionMeta, SocketStatus } from '../types';
import { SessionSidebar } from './SessionSidebar';
import { uid } from '../session/events';

/**
 * Entry point for /chat. If the connection already has at least one session,
 * redirect to it immediately; otherwise show the sidebar with a "create your
 * first session" affordance.
 */
export function ChatLanding() {
    const navigate = useNavigate();
    const [status, setStatus] = useState<SocketStatus>(sessionClient.getStatus());
    const [sessions, setSessions] = useState<ChatSessionMeta[]>(sessionClient.getSessions());

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

    const createSession = async (tool: 'claude' | 'gemini') => {
        const res = await sessionClient.rpc(uid(), 'session.create', { tool });
        const created = (res.result as { session?: ChatSessionMeta } | undefined)?.session;
        if (created) navigate(`/chat/${created.id}`);
    };

    return (
        <div className="chat-screen">
            <SessionSidebar activeSessionId={null} />
            <div className="chat-empty-pane">
                <div className="chat-empty-box">
                    <div className="chat-empty-title">还没有会话</div>
                    <div className="chat-empty-sub">
                        为当前连接创建第一个会话 —— 它会使用 agent 进程启动时所在的工作目录。
                    </div>
                    <div className="chat-empty-actions">
                        <button
                            type="button"
                            className="btn btn-primary btn-lg"
                            disabled={status !== 'connected'}
                            onClick={() => createSession('claude')}
                        >
                            新建 Claude 会话
                        </button>
                        <button
                            type="button"
                            className="btn btn-secondary btn-lg"
                            disabled={status !== 'connected'}
                            onClick={() => createSession('gemini')}
                        >
                            新建 Gemini 会话
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

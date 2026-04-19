import React, { memo, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useSession, useSessionMessages } from '@/sync/storage';
import { getSessionName, getSessionSubtitle, getSessionState } from '@/utils/sessionUtils';
import { ChatView } from '@/components/chat/ChatView';
import { Header } from '@/components/layout/Header';
import { sync } from '@/sync/sync';

export const SessionPage = memo(function SessionPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const session = useSession(id ?? '');
    const sessionMessages = useSessionMessages(id ?? '');

    useEffect(() => {
        if (!id) return;
        sync.onSessionVisible(id);
    }, [id]);

    const handleSend = useCallback((text: string) => {
        if (!id) return;
        sync.sendMessage(id, text);
    }, [id]);

    if (!id) return null;

    const messages = (sessionMessages?.messages ?? []) as Array<{ id: string; role: string; content: unknown; createdAt: number }>;
    const isLoaded = sessionMessages?.isLoaded ?? false;
    const state = session ? getSessionState(session) : 'disconnected';
    const thinking = state === 'thinking';
    const disabled = state === 'thinking' || !session?.active;

    const headerRight = (
        <div style={{ display: 'flex', gap: 4 }}>
            <button
                onClick={() => navigate(`/session/${id}/files`)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, color: 'var(--color-text-secondary)', fontSize: 18 }}
                title="Files"
            >
                📁
            </button>
            <button
                onClick={() => navigate(`/session/${id}/info`)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, color: 'var(--color-text-secondary)', fontSize: 18 }}
                title="Info"
            >
                ℹ️
            </button>
        </div>
    );

    const title = session ? getSessionName(session) : 'Session';
    const subtitle = session ? getSessionSubtitle(session) : undefined;

    return (
        <ChatView
            messages={messages}
            isLoaded={isLoaded}
            thinking={thinking}
            onSend={handleSend}
            disabled={disabled}
            enterToSend
            header={<Header title={title} subtitle={subtitle} showBack right={headerRight} />}
        />
    );
});

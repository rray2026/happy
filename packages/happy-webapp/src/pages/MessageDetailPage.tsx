import React, { memo } from 'react';
import { useParams } from 'react-router';
import { useSessionMessages } from '@/sync/storage';
import { Header } from '@/components/layout/Header';
import { MessageView } from '@/components/chat/MessageView';

export const MessageDetailPage = memo(function MessageDetailPage() {
    const { id, messageId } = useParams<{ id: string; messageId: string }>();
    const sessionMessages = useSessionMessages(id ?? '');

    const message = (sessionMessages?.messages ?? []).find(
        (m: unknown) => (m as Record<string, unknown>).id === messageId
    ) as { id: string; role: string; content: unknown; createdAt: number } | undefined;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title="Message" showBack />
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {message ? (
                    <MessageView message={message} />
                ) : (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                        Message not found
                    </div>
                )}
            </div>
        </div>
    );
});

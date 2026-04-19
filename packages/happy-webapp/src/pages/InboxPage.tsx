import React, { memo } from 'react';
import { useFeedItems } from '@/sync/storage';
import { Header } from '@/components/layout/Header';
import { FeedBody } from '@/sync/feedTypes';

function feedItemLabel(body: FeedBody): string {
    if (body.kind === 'friend_request') return 'Friend request received';
    if (body.kind === 'friend_accepted') return 'Friend request accepted';
    if (body.kind === 'text') return body.text;
    return 'Notification';
}

function feedItemIcon(body: FeedBody): string {
    if (body.kind === 'friend_request') return '👤';
    if (body.kind === 'friend_accepted') return '✅';
    return '🔔';
}

export const InboxPage = memo(function InboxPage() {
    const feedItems = useFeedItems();

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title="Inbox" />
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {feedItems.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 14 }}>
                        No notifications
                    </div>
                ) : (
                    feedItems.map(item => (
                        <div key={item.id} style={{
                            display: 'flex', alignItems: 'flex-start', gap: 14,
                            padding: '14px 16px',
                            borderBottom: '1px solid var(--color-divider)',
                        }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: 20,
                                background: 'var(--color-surface-high)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 20, flexShrink: 0,
                            }}>
                                {feedItemIcon(item.body)}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 14, color: 'var(--color-text)', lineHeight: 1.4 }}>
                                    {feedItemLabel(item.body)}
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                                    {new Date(item.createdAt).toLocaleString()}
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
});

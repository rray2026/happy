import React, { memo } from 'react';
import { Link } from 'react-router';
import { SessionRowData } from '@/sync/storage';
import { Avatar } from '@/components/ui/Avatar';
import { StatusDot } from '@/components/ui/StatusDot';
import { useElapsedTime } from '@/hooks/useElapsedTime';

function SessionRow({ row }: { row: SessionRowData }) {
    const elapsed = useElapsedTime(row.activeAt ?? row.createdAt ?? Date.now());

    let dotStatus: 'connected' | 'connecting' | 'disconnected' | 'permission' = 'disconnected';
    if (row.state === 'waiting') dotStatus = 'connected';
    else if (row.state === 'thinking') dotStatus = 'connecting';
    else if (row.state === 'permission_required') dotStatus = 'permission';

    return (
        <Link to={`/session/${row.id}`} style={{ textDecoration: 'none' }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 16px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'transparent', transition: 'background 0.1s',
                cursor: 'pointer',
            }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-high)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
                <div style={{ position: 'relative', flexShrink: 0 }}>
                    <Avatar id={row.avatarId} size={44} />
                    <div style={{ position: 'absolute', bottom: 0, right: 0 }}>
                        <StatusDot
                            status={dotStatus}
                            size={10}
                            pulse={row.state === 'thinking' || row.state === 'permission_required'}
                        />
                    </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {row.name}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                            {row.active ? 'online' : elapsed}
                        </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                        {row.subtitle}
                    </div>
                    {row.state === 'thinking' && (
                        <div style={{ fontSize: 12, color: 'var(--color-connecting)', marginTop: 2 }}>thinking...</div>
                    )}
                    {row.state === 'permission_required' && (
                        <div style={{ fontSize: 12, color: '#FF9500', marginTop: 2 }}>permission required</div>
                    )}
                </div>
                {row.hasDraft && (
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-connecting)', flexShrink: 0 }} />
                )}
            </div>
        </Link>
    );
}

interface SessionListProps {
    sessions: SessionRowData[];
    emptyMessage?: string;
}

export const SessionList = memo(function SessionList({ sessions, emptyMessage }: SessionListProps) {
    if (sessions.length === 0) {
        return (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 14 }}>
                {emptyMessage ?? 'No sessions yet'}
            </div>
        );
    }
    return (
        <div style={{ flex: 1, overflowY: 'auto' }}>
            {sessions.map(row => <SessionRow key={row.id} row={row} />)}
        </div>
    );
});

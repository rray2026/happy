import React, { memo } from 'react';
import { Link, useLocation } from 'react-router';
import { useSessionRows } from '@/sync/storage';
import { Avatar } from '@/components/ui/Avatar';
import { StatusDot } from '@/components/ui/StatusDot';
import { useConnectionStatus } from '@/sync/storage';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { SessionRowData } from '@/sync/storage';

function SessionItem({ row }: { row: SessionRowData }) {
    const location = useLocation();
    const isActive = location.pathname.startsWith(`/session/${row.id}`);
    const elapsed = useElapsedTime(row.activeAt ?? row.createdAt ?? Date.now());

    let dotStatus: 'connected' | 'connecting' | 'disconnected' | 'permission' = 'disconnected';
    if (row.state === 'waiting') dotStatus = 'connected';
    else if (row.state === 'thinking') dotStatus = 'connecting';
    else if (row.state === 'permission_required') dotStatus = 'permission';

    return (
        <Link
            to={`/session/${row.id}`}
            style={{ textDecoration: 'none' }}
        >
            <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                borderRadius: 8, cursor: 'pointer',
                background: isActive ? 'var(--color-surface-highest)' : 'transparent',
                transition: 'background 0.1s',
            }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-high)'; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
                <div style={{ position: 'relative', flexShrink: 0 }}>
                    <Avatar id={row.avatarId} size={32} />
                    <div style={{ position: 'absolute', bottom: -1, right: -1 }}>
                        <StatusDot status={dotStatus} size={8} />
                    </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'var(--color-text)', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.name}
                    </div>
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.active ? row.subtitle : elapsed}
                    </div>
                </div>
            </div>
        </Link>
    );
}

export const Sidebar = memo(function Sidebar() {
    const sessionRows = useSessionRows();
    const connectionStatus = useConnectionStatus();
    const location = useLocation();

    const navItems = [
        { to: '/inbox', label: 'Inbox', icon: '📬' },
        { to: '/friends', label: 'Friends', icon: '👥' },
        { to: '/artifacts', label: 'Artifacts', icon: '📄' },
        { to: '/settings', label: 'Settings', icon: '⚙️' },
    ];

    return (
        <div style={{
            width: 260, height: '100%', display: 'flex', flexDirection: 'column',
            background: 'var(--color-surface-high)',
            borderRight: '1px solid var(--color-divider)',
            overflow: 'hidden',
        }}>
            {/* Header */}
            <div style={{ padding: '16px 12px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-text)' }}>Happy</span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <StatusDot
                        status={connectionStatus === 'connected' ? 'connected' : connectionStatus === 'connecting' ? 'connecting' : 'disconnected'}
                        size={7}
                    />
                    <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{connectionStatus}</span>
                </div>
            </div>

            {/* Sessions list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
                {sessionRows.length === 0 ? (
                    <div style={{ padding: '24px 12px', color: 'var(--color-text-secondary)', fontSize: 13, textAlign: 'center' }}>
                        No sessions yet
                    </div>
                ) : (
                    sessionRows.map(row => <SessionItem key={row.id} row={row} />)
                )}
            </div>

            {/* Bottom nav */}
            <div style={{ borderTop: '1px solid var(--color-divider)', padding: '8px' }}>
                {navItems.map(item => {
                    const isActive = location.pathname.startsWith(item.to);
                    return (
                        <Link key={item.to} to={item.to} style={{ textDecoration: 'none' }}>
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '8px 12px', borderRadius: 8,
                                background: isActive ? 'var(--color-surface-highest)' : 'transparent',
                                color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)',
                                fontSize: 13, cursor: 'pointer', transition: 'background 0.1s',
                            }}
                                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-high)'; }}
                                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                            >
                                <span>{item.icon}</span>
                                <span>{item.label}</span>
                            </div>
                        </Link>
                    );
                })}
            </div>
        </div>
    );
});

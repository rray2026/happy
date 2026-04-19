import React, { memo } from 'react';
import { useSessionRows } from '@/sync/storage';
import { SessionList } from '@/components/session/SessionList';
import { Header } from '@/components/layout/Header';

function groupByDay(rows: ReturnType<typeof useSessionRows>) {
    const groups: { label: string; items: typeof rows }[] = [];
    const now = Date.now();
    const DAY = 86400000;

    const getLabel = (ts: number): string => {
        const diff = now - ts;
        if (diff < DAY) return 'Today';
        if (diff < 2 * DAY) return 'Yesterday';
        const days = Math.floor(diff / DAY);
        if (days < 7) return `${days} days ago`;
        return new Date(ts).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    };

    const sorted = [...rows].sort((a, b) => {
        const aTs = a.activeAt ?? a.createdAt ?? 0;
        const bTs = b.activeAt ?? b.createdAt ?? 0;
        return bTs - aTs;
    });

    for (const row of sorted) {
        const ts = row.activeAt ?? row.createdAt ?? 0;
        const label = getLabel(ts);
        const last = groups[groups.length - 1];
        if (last?.label === label) {
            last.items.push(row);
        } else {
            groups.push({ label, items: [row] });
        }
    }
    return groups;
}

export const RecentSessionsPage = memo(function RecentSessionsPage() {
    const sessions = useSessionRows();
    const groups = groupByDay(sessions);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title="Recent Sessions" showBack />
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {groups.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 14 }}>
                        No sessions yet
                    </div>
                ) : groups.map(group => (
                    <div key={group.label}>
                        <div style={{
                            padding: '8px 16px 4px',
                            fontSize: 12, fontWeight: 600,
                            color: 'var(--color-text-secondary)',
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                            borderBottom: '1px solid var(--color-divider)',
                        }}>
                            {group.label}
                        </div>
                        <SessionList sessions={group.items} />
                    </div>
                ))}
            </div>
        </div>
    );
});

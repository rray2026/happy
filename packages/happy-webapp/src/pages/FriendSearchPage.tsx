import React, { memo, useState, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { Item } from '@/components/ui/Item';
import { Button } from '@/components/ui/Button';
import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { sync } from '@/sync/sync';
import { useHappyAction } from '@/hooks/useHappyAction';

function SearchResult({ user, onAdd }: { user: UserProfile; onAdd: (id: string) => void }) {
    const [adding, handleAdd] = useHappyAction(() => sync.addFriend(user.username).then(() => onAdd(user.id)));
    return (
        <Item
            title={getDisplayName(user)}
            subtitle={`@${user.username}`}
            right={
                user.status === 'friend' ? (
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Friend</span>
                ) : user.status === 'requested' ? (
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Sent</span>
                ) : (
                    <Button size="sm" onClick={handleAdd} loading={adding}>Add</Button>
                )
            }
        />
    );
}

export const FriendSearchPage = memo(function FriendSearchPage() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<UserProfile[]>([]);
    const [searched, setSearched] = useState(false);
    const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

    const [searching, handleSearch] = useHappyAction(async () => {
        if (!query.trim()) return;
        const users = await sync.searchUsers(query.trim());
        setResults(users);
        setSearched(true);
    });

    const handleAdd = useCallback((id: string) => {
        setAddedIds(prev => new Set([...prev, id]));
        setResults(prev => prev.map(u => u.id === id ? { ...u, status: 'requested' as const } : u));
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title="Find Friends" showBack />
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-divider)', display: 'flex', gap: 8 }}>
                <input
                    type="text"
                    placeholder="Search by username..."
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    style={{
                        flex: 1, padding: '8px 12px', borderRadius: 10,
                        border: '1px solid var(--color-divider)',
                        background: 'var(--color-surface-high)', color: 'var(--color-text)',
                        fontSize: 14, outline: 'none',
                    }}
                />
                <Button onClick={handleSearch} loading={searching} size="sm">Search</Button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {searched && results.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 14 }}>
                        No users found
                    </div>
                ) : (
                    results.map(user => (
                        <SearchResult key={user.id} user={user} onAdd={handleAdd} />
                    ))
                )}
            </div>
        </div>
    );
});

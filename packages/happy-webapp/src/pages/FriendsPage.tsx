import React, { memo } from 'react';
import { useNavigate } from 'react-router';
import { Header } from '@/components/layout/Header';
import { ItemGroup } from '@/components/ui/ItemGroup';
import { Item } from '@/components/ui/Item';
import { Button } from '@/components/ui/Button';
import { useFriends } from '@/sync/storage';
import { getDisplayName, isFriend, isPendingRequest, isRequested } from '@/sync/friendTypes';
import { sync } from '@/sync/sync';
import { useHappyAction } from '@/hooks/useHappyAction';

function FriendItem({ friend }: { friend: ReturnType<typeof useFriends>[0] }) {
    const name = getDisplayName(friend);
    const [accepting, handleAccept] = useHappyAction(() => sync.acceptFriendRequest(friend.id));
    const [removing, handleRemove] = useHappyAction(() => sync.removeFriend(friend.id));

    return (
        <Item
            title={name}
            subtitle={`@${friend.username}`}
            right={
                isPendingRequest(friend.status) ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                        <Button size="sm" onClick={handleAccept} loading={accepting}>Accept</Button>
                        <Button size="sm" variant="ghost" onClick={handleRemove} loading={removing}>Decline</Button>
                    </div>
                ) : (
                    <Button size="sm" variant="ghost" onClick={handleRemove} loading={removing}>Remove</Button>
                )
            }
        />
    );
}

export const FriendsPage = memo(function FriendsPage() {
    const navigate = useNavigate();
    const friends = useFriends();

    const accepted = friends.filter(f => isFriend(f.status));
    const pending = friends.filter(f => isPendingRequest(f.status));
    const requested = friends.filter(f => isRequested(f.status));

    const searchRight = (
        <button
            onClick={() => navigate('/friends/search')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, color: 'var(--color-text-link)', fontSize: 14 }}
        >
            + Add
        </button>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
            <Header title="Friends" right={searchRight} />
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                {pending.length > 0 && (
                    <ItemGroup title="Requests">
                        {pending.map(f => <FriendItem key={f.id} friend={f} />)}
                    </ItemGroup>
                )}
                {requested.length > 0 && (
                    <ItemGroup title="Sent">
                        {requested.map(f => <FriendItem key={f.id} friend={f} />)}
                    </ItemGroup>
                )}
                <ItemGroup title={accepted.length > 0 ? 'Friends' : ''}>
                    {accepted.length > 0 ? (
                        accepted.map(f => <FriendItem key={f.id} friend={f} />)
                    ) : (
                        <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 14 }}>
                            No friends yet. Search for users to add.
                        </div>
                    )}
                </ItemGroup>
            </div>
        </div>
    );
});

import React, { memo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useSession } from '@/sync/storage';
import { Header } from '@/components/layout/Header';
import { Item } from '@/components/ui/Item';
import { ItemGroup } from '@/components/ui/ItemGroup';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { getSessionName, getSessionAvatarId, getSessionState, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { sync } from '@/sync/sync';
import { useHappyAction } from '@/hooks/useHappyAction';

export const SessionInfoPage = memo(function SessionInfoPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const session = useSession(id ?? '');

    const [deleting, handleDelete] = useHappyAction(async () => {
        if (!id) return;
        await sync.deleteSession(id);
        navigate('/', { replace: true });
    });

    if (!id || !session) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <Header title="Session Info" showBack />
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Session not found</div>
            </div>
        );
    }

    const name = getSessionName(session);
    const avatarId = getSessionAvatarId(session);
    const state = getSessionState(session);
    const meta = session.metadata;
    const path = meta ? formatPathRelativeToHome(meta.path, meta.homeDir) : null;

    const stateLabel: Record<string, string> = {
        connected: 'Connected', disconnected: 'Offline', thinking: 'Thinking', waiting: 'Waiting', permission_required: 'Permission Required',
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
            <Header title="Session Info" showBack />

            {/* Avatar + name */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 16px 16px' }}>
                <Avatar id={avatarId} size={72} />
                <div style={{ marginTop: 12, fontWeight: 700, fontSize: 18, color: 'var(--color-text)', textAlign: 'center' }}>{name}</div>
                <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-secondary)' }}>{stateLabel[state] ?? state}</div>
            </div>

            <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <ItemGroup title="Session">
                    {path && <Item title="Path" detail={path} />}
                    {meta?.host && <Item title="Host" detail={meta.host} />}
                    {meta?.version && <Item title="CLI Version" detail={meta.version} />}
                    {meta?.os && <Item title="OS" detail={meta.os} />}
                    {meta?.machineId && <Item title="Machine ID" detail={meta.machineId} />}
                    <Item title="Created" detail={new Date(session.createdAt).toLocaleString()} />
                    {session.activeAt > 0 && <Item title="Last Active" detail={new Date(session.activeAt).toLocaleString()} />}
                </ItemGroup>

                {meta?.flavor && (
                    <ItemGroup title="Agent">
                        <Item title="Flavor" detail={meta.flavor} />
                    </ItemGroup>
                )}

                <ItemGroup title="Actions">
                    <Button
                        variant="destructive"
                        onClick={handleDelete}
                        loading={deleting}
                        style={{ width: '100%', justifyContent: 'center' }}
                    >
                        Delete Session
                    </Button>
                </ItemGroup>
            </div>
        </div>
    );
});

import React, { memo, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useMachine, useSettings } from '@/sync/storage';
import { Header } from '@/components/layout/Header';
import { Item } from '@/components/ui/Item';
import { ItemGroup } from '@/components/ui/ItemGroup';
import { Button } from '@/components/ui/Button';
import { getMachineDisplayName } from '@/utils/machineUtils';
import { sync } from '@/sync/sync';
import { useHappyAction } from '@/hooks/useHappyAction';

export const MachinePage = memo(function MachinePage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const machine = useMachine(id ?? '');
    const settings = useSettings();

    const [path, setPath] = useState('');
    const [stopping, handleStop] = useHappyAction(async () => {
        if (!id) return;
        await sync.stopMachineDaemon(id);
    });
    const [spawning, handleSpawn] = useHappyAction(async () => {
        if (!id || !path.trim()) return;
        await sync.spawnSession(id, path.trim());
        navigate('/');
    });

    if (!id || !machine) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <Header title="Machine" showBack />
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Machine not found</div>
            </div>
        );
    }

    const name = getMachineDisplayName(machine);
    const meta = machine.metadata;
    const recentPaths = settings.recentMachinePaths
        .filter(p => p.machineId === id)
        .map(p => p.path);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
            <Header title={name} subtitle={meta?.host} showBack />
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <ItemGroup title="Machine">
                    {meta?.host && <Item title="Host" detail={meta.host} />}
                    {meta?.platform && <Item title="Platform" detail={meta.platform} />}
                    {meta?.arch && <Item title="Architecture" detail={meta.arch} />}
                    {meta?.username && <Item title="User" detail={meta.username} />}
                    {meta?.happyCliVersion && <Item title="Happy CLI" detail={meta.happyCliVersion} />}
                    <Item title="Status" detail={machine.active ? 'Online' : 'Offline'} />
                </ItemGroup>

                {machine.active && (
                    <ItemGroup title="Spawn Session" footer="Enter the working directory path for the new session.">
                        <div style={{ padding: '12px 16px' }}>
                            <input
                                type="text"
                                placeholder={meta?.homeDir ?? '/'}
                                value={path}
                                onChange={e => setPath(e.target.value)}
                                style={{
                                    width: '100%', padding: '8px 12px', borderRadius: 10,
                                    border: '1px solid var(--color-divider)',
                                    background: 'var(--color-surface-high)', color: 'var(--color-text)',
                                    fontSize: 14, fontFamily: 'IBMPlexMono, monospace',
                                    outline: 'none', boxSizing: 'border-box',
                                }}
                            />
                        </div>
                        {recentPaths.length > 0 && (
                            <div style={{ padding: '0 16px 8px' }}>
                                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Recent paths</div>
                                {recentPaths.slice(0, 5).map(p => (
                                    <button
                                        key={p}
                                        onClick={() => setPath(p)}
                                        style={{
                                            display: 'block', width: '100%', textAlign: 'left',
                                            padding: '4px 0', background: 'none', border: 'none',
                                            cursor: 'pointer', fontFamily: 'IBMPlexMono, monospace',
                                            fontSize: 12, color: 'var(--color-text-link)',
                                        }}
                                    >
                                        {p}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div style={{ padding: '0 16px 12px' }}>
                            <Button
                                onClick={handleSpawn}
                                loading={spawning}
                                disabled={!path.trim()}
                                style={{ width: '100%', justifyContent: 'center' }}
                            >
                                Start Session
                            </Button>
                        </div>
                    </ItemGroup>
                )}

                {machine.active && (
                    <ItemGroup title="Daemon">
                        <Button
                            variant="destructive"
                            onClick={handleStop}
                            loading={stopping}
                            style={{ width: '100%', justifyContent: 'center', margin: '8px 0' }}
                        >
                            Stop Daemon
                        </Button>
                    </ItemGroup>
                )}
            </div>
        </div>
    );
});

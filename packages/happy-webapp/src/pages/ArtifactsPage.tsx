import React, { memo } from 'react';
import { useNavigate, Link } from 'react-router';
import { useArtifacts } from '@/sync/storage';
import { Header } from '@/components/layout/Header';

export const ArtifactsPage = memo(function ArtifactsPage() {
    const navigate = useNavigate();
    const artifacts = useArtifacts();

    const createBtn = (
        <button
            onClick={() => navigate('/artifacts/new')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, color: 'var(--color-text-link)', fontSize: 14 }}
        >
            + New
        </button>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title="Artifacts" right={createBtn} />
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {artifacts.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 14 }}>
                        No artifacts yet
                    </div>
                ) : (
                    artifacts.map(artifact => (
                        <Link
                            key={artifact.id}
                            to={`/artifacts/${artifact.id}`}
                            style={{ textDecoration: 'none' }}
                        >
                            <div style={{
                                padding: '14px 16px',
                                borderBottom: '1px solid var(--color-divider)',
                                cursor: 'pointer',
                            }}
                                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-high)'; }}
                                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                            >
                                <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-text)' }}>
                                    {artifact.title ?? 'Untitled'}
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                                    {new Date(artifact.updatedAt).toLocaleDateString()}
                                </div>
                            </div>
                        </Link>
                    ))
                )}
            </div>
        </div>
    );
});

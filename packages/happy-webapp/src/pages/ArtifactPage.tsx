import React, { memo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useArtifacts } from '@/sync/storage';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';

export const ArtifactPage = memo(function ArtifactPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const artifacts = useArtifacts();
    const artifact = artifacts.find(a => a.id === id);

    if (!artifact) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <Header title="Artifact" showBack />
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Not found</div>
            </div>
        );
    }

    const editBtn = (
        <Button size="sm" variant="secondary" onClick={() => navigate(`/artifacts/edit/${id}`)}>Edit</Button>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title={artifact.title ?? 'Untitled'} showBack right={editBtn} />
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                {artifact.body ? (
                    <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {artifact.body}
                    </div>
                ) : (
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 14, textAlign: 'center', marginTop: 40 }}>
                        No content
                    </div>
                )}
                <div style={{ marginTop: 24, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    Updated {new Date(artifact.updatedAt).toLocaleString()}
                </div>
            </div>
        </div>
    );
});

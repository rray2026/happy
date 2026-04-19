import React, { memo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { sync } from '@/sync/sync';
import { useHappyAction } from '@/hooks/useHappyAction';

export const NewArtifactPage = memo(function NewArtifactPage() {
    const navigate = useNavigate();
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');

    const [saving, handleSave] = useHappyAction(async () => {
        await sync.createArtifact(title.trim() || null, body.trim() || null);
        navigate('/artifacts', { replace: true });
    });

    const saveBtn = (
        <Button size="sm" onClick={handleSave} loading={saving}>Save</Button>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title="New Artifact" showBack right={saveBtn} />
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <input
                    type="text"
                    placeholder="Title"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    style={{
                        width: '100%', padding: '10px 14px', borderRadius: 10,
                        border: '1px solid var(--color-divider)',
                        background: 'var(--color-surface-high)', color: 'var(--color-text)',
                        fontSize: 16, fontWeight: 600, outline: 'none', boxSizing: 'border-box',
                    }}
                />
                <textarea
                    placeholder="Write something..."
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    style={{
                        flex: 1, width: '100%', padding: '10px 14px', borderRadius: 10,
                        border: '1px solid var(--color-divider)',
                        background: 'var(--color-surface-high)', color: 'var(--color-text)',
                        fontSize: 14, outline: 'none', resize: 'none',
                        minHeight: 300, boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.6,
                    }}
                />
            </div>
        </div>
    );
});

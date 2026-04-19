import React, { memo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useSession } from '@/sync/storage';
import { Header } from '@/components/layout/Header';
import { getSessionName } from '@/utils/sessionUtils';

export const SessionFilesPage = memo(function SessionFilesPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const session = useSession(id ?? '');
    const name = session ? getSessionName(session) : 'Session';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title="Files" subtitle={name} showBack />
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                <p style={{ color: 'var(--color-text-secondary)', fontSize: 14, textAlign: 'center', marginTop: 40 }}>
                    File browser coming soon.
                </p>
            </div>
        </div>
    );
});

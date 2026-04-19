import React, { memo, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Header } from '@/components/layout/Header';

export const SessionFilePage = memo(function SessionFilePage() {
    const { id } = useParams<{ id: string }>();
    const [searchParams] = useSearchParams();
    const filePath = searchParams.get('path') ?? '';
    const [content, setContent] = useState<string | null>(null);

    const fileName = filePath.split('/').pop() ?? filePath;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Header title={fileName} subtitle={filePath} showBack />
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                {content === null ? (
                    <p style={{ color: 'var(--color-text-secondary)', fontSize: 14, textAlign: 'center', marginTop: 40 }}>
                        File viewer coming soon.
                    </p>
                ) : (
                    <pre style={{ fontFamily: 'IBMPlexMono, monospace', fontSize: 13, color: 'var(--color-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {content}
                    </pre>
                )}
            </div>
        </div>
    );
});

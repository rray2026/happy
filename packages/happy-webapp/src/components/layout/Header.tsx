import React, { memo } from 'react';
import { useNavigate } from 'react-router';

interface HeaderProps {
    title: string;
    subtitle?: string;
    showBack?: boolean;
    right?: React.ReactNode;
}

export const Header = memo(function Header({ title, subtitle, showBack, right }: HeaderProps) {
    const navigate = useNavigate();
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px',
            borderBottom: '1px solid var(--color-divider)',
            background: 'var(--color-header-bg)',
            minHeight: 52, flexShrink: 0,
        }}>
            {showBack && (
                <button
                    onClick={() => navigate(-1)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px 4px 0', color: 'var(--color-text-link)' }}
                >
                    ← Back
                </button>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {title}
                </div>
                {subtitle && (
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {subtitle}
                    </div>
                )}
            </div>
            {right}
        </div>
    );
});

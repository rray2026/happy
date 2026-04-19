import React, { memo } from 'react';

interface ItemProps {
    title: string;
    subtitle?: string;
    detail?: string;
    icon?: React.ReactNode;
    right?: React.ReactNode;
    chevron?: boolean;
    onPress?: () => void;
    destructive?: boolean;
    loading?: boolean;
    disabled?: boolean;
}

export const Item = memo(function Item({
    title, subtitle, detail, icon, right, chevron, onPress, destructive, loading, disabled,
}: ItemProps) {
    const isClickable = !!onPress && !disabled && !loading;
    return (
        <div
            role={isClickable ? 'button' : undefined}
            tabIndex={isClickable ? 0 : undefined}
            onClick={isClickable ? onPress : undefined}
            onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onPress?.(); } : undefined}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                cursor: isClickable ? 'pointer' : 'default',
                opacity: disabled ? 0.5 : 1,
                background: 'transparent',
                transition: 'background 0.1s',
                minHeight: 48,
                userSelect: 'none',
            }}
            onMouseEnter={e => { if (isClickable) (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-pressed)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
            {icon && <span style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }}>{icon}</span>}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                    color: destructive ? 'var(--color-text-destructive)' : 'var(--color-text)',
                    fontSize: 15, fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                    {title}
                </div>
                {subtitle && (
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {subtitle}
                    </div>
                )}
            </div>
            {detail && <span style={{ color: 'var(--color-text-secondary)', fontSize: 14, flexShrink: 0 }}>{detail}</span>}
            {right}
            {loading && (
                <div style={{ width: 16, height: 16, border: '2px solid var(--color-divider)', borderTopColor: 'var(--color-text-secondary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
            )}
            {chevron && (
                <svg width="8" height="14" viewBox="0 0 8 14" fill="none" style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }}>
                    <path d="M1 1l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            )}
        </div>
    );
});

import React, { memo } from 'react';

type Variant = 'primary' | 'secondary' | 'destructive' | 'ghost';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    loading?: boolean;
    size?: 'sm' | 'md' | 'lg';
}

const VARIANT_STYLES: Record<Variant, React.CSSProperties> = {
    primary: { background: 'var(--color-primary)', color: 'var(--color-primary-foreground)' },
    secondary: { background: 'var(--color-surface-highest)', color: 'var(--color-text)' },
    destructive: { background: 'var(--color-error)', color: '#fff' },
    ghost: { background: 'transparent', color: 'var(--color-text)' },
};

const SIZE_STYLES: Record<'sm' | 'md' | 'lg', React.CSSProperties> = {
    sm: { padding: '4px 10px', fontSize: 13, borderRadius: 6 },
    md: { padding: '8px 16px', fontSize: 14, borderRadius: 8 },
    lg: { padding: '12px 24px', fontSize: 15, borderRadius: 10 },
};

export const Button = memo(function Button({
    variant = 'primary', loading, size = 'md', disabled, children, style, ...rest
}: ButtonProps) {
    return (
        <button
            {...rest}
            disabled={disabled || loading}
            style={{
                ...VARIANT_STYLES[variant],
                ...SIZE_STYLES[size],
                fontFamily: 'IBMPlexSans, system-ui, sans-serif',
                fontWeight: 500,
                border: 'none',
                cursor: disabled || loading ? 'not-allowed' : 'pointer',
                opacity: disabled || loading ? 0.6 : 1,
                transition: 'opacity 0.15s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                whiteSpace: 'nowrap',
                ...style,
            }}
        >
            {loading && (
                <span style={{
                    width: 12, height: 12, border: '2px solid currentColor',
                    borderTopColor: 'transparent', borderRadius: '50%',
                    animation: 'spin 0.7s linear infinite', display: 'inline-block',
                }} />
            )}
            {children}
        </button>
    );
});

import React, { memo } from 'react';

interface SpinnerProps {
    size?: number;
    color?: string;
}

export const Spinner = memo(function Spinner({ size = 24, color }: SpinnerProps) {
    return (
        <>
            <div style={{
                width: size, height: size,
                border: `${Math.max(2, size / 10)}px solid var(--color-divider)`,
                borderTopColor: color ?? 'var(--color-text)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
                flexShrink: 0,
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </>
    );
});

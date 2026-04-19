import React, { memo } from 'react';

type Status = 'connected' | 'connecting' | 'disconnected' | 'error' | 'permission';

const STATUS_COLORS: Record<Status, string> = {
    connected: 'var(--color-connected)',
    connecting: 'var(--color-connecting)',
    disconnected: 'var(--color-disconnected)',
    error: 'var(--color-error)',
    permission: '#FF9500',
};

interface StatusDotProps {
    status: Status;
    size?: number;
    pulse?: boolean;
}

export const StatusDot = memo(function StatusDot({ status, size = 8, pulse }: StatusDotProps) {
    const color = STATUS_COLORS[status];
    return (
        <span
            style={{
                display: 'inline-block',
                width: size,
                height: size,
                borderRadius: '50%',
                background: color,
                flexShrink: 0,
                animation: pulse ? 'pulse 2s ease-in-out infinite' : undefined,
            }}
        />
    );
});

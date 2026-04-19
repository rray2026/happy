import React, { memo } from 'react';

interface SwitchProps {
    value: boolean;
    onValueChange: (val: boolean) => void;
    disabled?: boolean;
}

export const Switch = memo(function Switch({ value, onValueChange, disabled }: SwitchProps) {
    return (
        <button
            role="switch"
            aria-checked={value}
            disabled={disabled}
            onClick={() => onValueChange(!value)}
            style={{
                width: 44, height: 24, borderRadius: 12, border: 'none',
                background: value ? 'var(--color-switch-active)' : 'var(--color-switch-inactive)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                position: 'relative', transition: 'background 0.2s',
                opacity: disabled ? 0.5 : 1, flexShrink: 0, padding: 0,
            }}
        >
            <span style={{
                position: 'absolute', top: 2, left: value ? 22 : 2,
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'left 0.2s',
            }} />
        </button>
    );
});

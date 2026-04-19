import React, { memo } from 'react';

function hashCode(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

const GRADIENT_PAIRS = [
    ['#FF6B6B', '#FFE66D'],
    ['#4ECDC4', '#44A8B3'],
    ['#A8E063', '#56AB2F'],
    ['#FFA17F', '#00223E'],
    ['#C9FFBF', '#FFAFBD'],
    ['#2193b0', '#6dd5ed'],
    ['#cc2b5e', '#753a88'],
    ['#f7971e', '#ffd200'],
    ['#56CCF2', '#2F80ED'],
    ['#11998e', '#38ef7d'],
];

const BRUTALIST_PATTERNS = [
    { bg: '#000000', fg: '#FFFFFF' },
    { bg: '#FFFFFF', fg: '#000000' },
    { bg: '#FF0000', fg: '#000000' },
    { bg: '#0000FF', fg: '#FFFFFF' },
    { bg: '#FFFF00', fg: '#000000' },
    { bg: '#00FF00', fg: '#000000' },
    { bg: '#FF6600', fg: '#FFFFFF' },
    { bg: '#9900FF', fg: '#FFFFFF' },
];

interface AvatarProps {
    id: string;
    size?: number;
    style?: 'gradient' | 'brutalist' | 'pixelated';
    className?: string;
}

export const Avatar = memo(function Avatar({ id, size = 40, style = 'brutalist', className }: AvatarProps) {
    const hash = hashCode(id);
    const initials = id.slice(0, 2).toUpperCase();
    const radius = size * 0.2;

    if (style === 'gradient') {
        const [c1, c2] = GRADIENT_PAIRS[hash % GRADIENT_PAIRS.length];
        return (
            <div
                className={className}
                style={{
                    width: size, height: size, borderRadius: radius,
                    background: `linear-gradient(135deg, ${c1}, ${c2})`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                }}
            >
                <span style={{ color: '#fff', fontWeight: 600, fontSize: size * 0.35 }}>{initials}</span>
            </div>
        );
    }

    if (style === 'brutalist') {
        const { bg, fg } = BRUTALIST_PATTERNS[hash % BRUTALIST_PATTERNS.length];
        return (
            <div
                className={className}
                style={{
                    width: size, height: size, borderRadius: radius,
                    background: bg, border: `2px solid ${fg === '#000000' ? '#00000033' : '#ffffff33'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                }}
            >
                <span style={{ color: fg, fontWeight: 700, fontSize: size * 0.35, fontFamily: 'IBMPlexMono, monospace' }}>
                    {initials}
                </span>
            </div>
        );
    }

    // pixelated
    const rows = 5;
    const cols = 5;
    const cellSize = size / cols;
    const palette = ['#000', '#333', '#666', '#999', '#ccc', '#fff', '#f00', '#0f0', '#00f', '#ff0'];
    const cells = Array.from({ length: rows * cols }, (_, i) => palette[(hash * (i + 1)) % palette.length]);

    return (
        <div
            className={className}
            style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', flexShrink: 0 }}
        >
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, width: size, height: size }}>
                {cells.map((c, i) => (
                    <div key={i} style={{ background: c, width: cellSize, height: cellSize }} />
                ))}
            </div>
        </div>
    );
});

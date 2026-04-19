import React, { memo } from 'react';

interface ItemGroupProps {
    title?: string;
    footer?: string;
    children: React.ReactNode;
}

export const ItemGroup = memo(function ItemGroup({ title, footer, children }: ItemGroupProps) {
    return (
        <div style={{ marginBottom: 24 }}>
            {title && (
                <div style={{
                    color: 'var(--color-grouped-section-title)',
                    fontSize: 13, fontWeight: 500,
                    textTransform: 'uppercase', letterSpacing: 0.5,
                    padding: '0 16px', marginBottom: 6,
                }}>
                    {title}
                </div>
            )}
            <div style={{
                background: 'var(--color-surface)',
                borderRadius: 12,
                overflow: 'hidden',
            }}>
                {React.Children.map(children, (child, i) => (
                    <>
                        {child}
                        {i < React.Children.count(children) - 1 && (
                            <div style={{ height: 1, background: 'var(--color-divider)', marginLeft: 16 }} />
                        )}
                    </>
                ))}
            </div>
            {footer && (
                <div style={{
                    color: 'var(--color-grouped-section-title)',
                    fontSize: 13, padding: '6px 16px',
                }}>
                    {footer}
                </div>
            )}
        </div>
    );
});

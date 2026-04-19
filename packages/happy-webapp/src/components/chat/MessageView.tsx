import React, { memo, useState } from 'react';

interface Message {
    id: string;
    role: string;
    content: unknown;
    createdAt: number;
}

function renderContent(content: unknown): React.ReactNode {
    if (!content) return null;
    if (typeof content === 'string') return content;
    const c = content as Record<string, unknown>;
    if (c.type === 'text') return c.text as string;
    if (c.type === 'tool_use') return <ToolUseView name={c.name as string} input={c.input} id={c.id as string} />;
    if (c.type === 'tool_result') return <ToolResultView content={c.content} isError={c.is_error as boolean} />;
    if (Array.isArray(content)) {
        return <>{content.map((item, i) => <div key={i}>{renderContent(item)}</div>)}</>;
    }
    return <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(content, null, 2)}</pre>;
}

function ToolUseView({ name, input, id }: { name: string; input: unknown; id: string }) {
    const [open, setOpen] = useState(false);
    return (
        <div style={{
            border: '1px solid var(--color-divider)',
            borderRadius: 8, overflow: 'hidden', margin: '4px 0',
        }}>
            <button
                onClick={() => setOpen(v => !v)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '8px 12px', background: 'var(--color-surface-high)',
                    border: 'none', cursor: 'pointer', textAlign: 'left',
                    color: 'var(--color-text)',
                }}
            >
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>⚙</span>
                <span style={{ fontFamily: 'IBMPlexMono, monospace', fontSize: 13, fontWeight: 600 }}>{name}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-secondary)' }}>{open ? '▲' : '▼'}</span>
            </button>
            {open && (
                <pre style={{
                    margin: 0, padding: '8px 12px',
                    fontSize: 12, fontFamily: 'IBMPlexMono, monospace',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    color: 'var(--color-text)',
                    background: 'var(--color-surface)',
                    borderTop: '1px solid var(--color-divider)',
                }}>
                    {JSON.stringify(input, null, 2)}
                </pre>
            )}
        </div>
    );
}

function ToolResultView({ content, isError }: { content: unknown; isError: boolean }) {
    const [open, setOpen] = useState(false);
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const preview = text.slice(0, 120) + (text.length > 120 ? '...' : '');
    return (
        <div style={{
            border: `1px solid ${isError ? 'var(--color-error)' : 'var(--color-divider)'}`,
            borderRadius: 8, overflow: 'hidden', margin: '4px 0',
        }}>
            <button
                onClick={() => setOpen(v => !v)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '6px 12px', background: isError ? 'rgba(255,59,48,0.08)' : 'var(--color-surface-high)',
                    border: 'none', cursor: 'pointer', textAlign: 'left',
                    color: isError ? 'var(--color-error)' : 'var(--color-text)',
                    fontSize: 12,
                }}
            >
                <span>{isError ? '✕' : '✓'}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'IBMPlexMono, monospace' }}>
                    {open ? 'Tool Result' : preview}
                </span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{open ? '▲' : '▼'}</span>
            </button>
            {open && (
                <pre style={{
                    margin: 0, padding: '8px 12px',
                    fontSize: 12, fontFamily: 'IBMPlexMono, monospace',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    color: 'var(--color-text)', background: 'var(--color-surface)',
                    borderTop: '1px solid var(--color-divider)',
                    maxHeight: 400, overflowY: 'auto',
                }}>
                    {text}
                </pre>
            )}
        </div>
    );
}

export const MessageView = memo(function MessageView({ message }: { message: Message }) {
    const isUser = message.role === 'user';
    const isAssistant = message.role === 'assistant';
    const isEvent = message.role === 'event';

    if (isEvent) {
        const c = message.content as Record<string, unknown>;
        return (
            <div style={{ padding: '4px 16px', textAlign: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-surface-high)', padding: '2px 8px', borderRadius: 10 }}>
                    {c.message as string ?? 'Event'}
                </span>
            </div>
        );
    }

    if (isUser) {
        return (
            <div style={{ padding: '8px 16px', display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{
                    maxWidth: '75%', padding: '10px 14px',
                    background: 'var(--color-primary)', color: 'var(--color-primary-foreground)',
                    borderRadius: '16px 16px 4px 16px',
                    fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                    {renderContent(message.content)}
                </div>
            </div>
        );
    }

    if (isAssistant) {
        const content = message.content;
        const items = Array.isArray(content) ? content : [content];
        return (
            <div style={{ padding: '8px 16px' }}>
                <div style={{ maxWidth: '100%', fontSize: 14, lineHeight: 1.6, color: 'var(--color-text)' }}>
                    {items.map((item, i) => (
                        <div key={i}>{renderContent(item)}</div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div style={{ padding: '4px 16px', fontSize: 13, color: 'var(--color-text-secondary)' }}>
            {renderContent(message.content)}
        </div>
    );
});

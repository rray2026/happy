import React, { memo, useRef, useCallback, KeyboardEvent } from 'react';

interface ChatInputProps {
    onSend: (text: string) => void;
    disabled?: boolean;
    enterToSend?: boolean;
    placeholder?: string;
}

export const ChatInput = memo(function ChatInput({ onSend, disabled, enterToSend = true, placeholder }: ChatInputProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const handleSend = useCallback(() => {
        const text = textareaRef.current?.value.trim();
        if (!text || disabled) return;
        onSend(text);
        if (textareaRef.current) {
            textareaRef.current.value = '';
            textareaRef.current.style.height = 'auto';
        }
    }, [onSend, disabled]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (enterToSend) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        } else {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
            }
        }
    }, [handleSend, enterToSend]);

    const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const el = e.target;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }, []);

    return (
        <div style={{
            display: 'flex', alignItems: 'flex-end', gap: 8,
            padding: '12px 16px',
            borderTop: '1px solid var(--color-divider)',
            background: 'var(--color-surface)',
        }}>
            <textarea
                ref={textareaRef}
                rows={1}
                placeholder={placeholder ?? (enterToSend ? 'Message... (Enter to send)' : 'Message... (⌘+Enter to send)')}
                disabled={disabled}
                onKeyDown={handleKeyDown}
                onInput={handleInput}
                style={{
                    flex: 1, resize: 'none', border: '1px solid var(--color-divider)',
                    borderRadius: 12, padding: '10px 14px',
                    background: 'var(--color-surface-high)', color: 'var(--color-text)',
                    fontSize: 14, fontFamily: 'IBMPlexSans, system-ui, sans-serif',
                    outline: 'none', lineHeight: 1.5,
                    maxHeight: 200, overflowY: 'auto',
                    transition: 'border-color 0.15s',
                }}
                onFocus={e => { e.target.style.borderColor = 'var(--color-text-secondary)'; }}
                onBlur={e => { e.target.style.borderColor = 'var(--color-divider)'; }}
            />
            <button
                onClick={handleSend}
                disabled={disabled}
                style={{
                    width: 36, height: 36, borderRadius: 18,
                    background: disabled ? 'var(--color-divider)' : 'var(--color-primary)',
                    color: 'var(--color-primary-foreground)',
                    border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0, fontSize: 16, transition: 'background 0.15s',
                }}
            >
                ↑
            </button>
        </div>
    );
});

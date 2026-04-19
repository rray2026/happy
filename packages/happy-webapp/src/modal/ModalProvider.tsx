import React, { createContext, useContext, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ModalConfig } from './types';
import { registerModalShow } from './ModalManager';

const ModalContext = createContext<{ show: (config: ModalConfig) => void }>({ show: () => {} });

export function useModal() {
    return useContext(ModalContext);
}

export function ModalProvider({ children }: { children: React.ReactNode }) {
    const [config, setConfig] = useState<ModalConfig | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const show = (cfg: ModalConfig) => setConfig(cfg);

    React.useEffect(() => {
        registerModalShow(show);
    }, []);

    React.useEffect(() => {
        if (config?.prompt && inputRef.current) {
            inputRef.current.focus();
        }
    }, [config]);

    const dismiss = () => setConfig(null);

    return (
        <ModalContext.Provider value={{ show }}>
            {children}
            {config && createPortal(
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.5)' }}
                    onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
                >
                    <div className="rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
                        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-divider)' }}>
                        <h2 className="font-semibold text-lg mb-1"
                            style={{ color: 'var(--color-text)' }}>{config.title}</h2>
                        {config.message && (
                            <p className="mb-4 text-sm"
                                style={{ color: 'var(--color-text-secondary)' }}>{config.message}</p>
                        )}
                        {config.prompt && (
                            <input
                                ref={inputRef}
                                className="w-full rounded-lg px-3 py-2 mb-4 text-sm outline-none"
                                style={{
                                    background: 'var(--color-surface-high)',
                                    color: 'var(--color-text)',
                                    border: '1px solid var(--color-divider)',
                                }}
                                placeholder={config.prompt.placeholder}
                                defaultValue={config.prompt.defaultValue}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && inputRef.current) {
                                        config.prompt!.onSubmit(inputRef.current.value);
                                        dismiss();
                                    }
                                }}
                            />
                        )}
                        <div className="flex gap-2 justify-end">
                            {config.buttons.map((btn, i) => (
                                <button
                                    key={i}
                                    className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
                                    style={{
                                        background: btn.style === 'destructive'
                                            ? 'var(--color-error)'
                                            : btn.style === 'cancel'
                                                ? 'var(--color-surface-highest)'
                                                : 'var(--color-primary)',
                                        color: btn.style === 'cancel'
                                            ? 'var(--color-text)'
                                            : 'var(--color-primary-foreground)',
                                    }}
                                    onClick={() => {
                                        if (config.prompt && btn.style !== 'cancel' && inputRef.current) {
                                            config.prompt.onSubmit(inputRef.current.value);
                                        }
                                        btn.onPress?.();
                                        dismiss();
                                    }}
                                >
                                    {btn.text}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </ModalContext.Provider>
    );
}

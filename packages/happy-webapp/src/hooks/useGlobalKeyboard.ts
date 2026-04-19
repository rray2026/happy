import { useEffect } from 'react';

export interface KeyBinding {
    key: string;
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    action: () => void;
}

export function useGlobalKeyboard(bindings: KeyBinding[]) {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            for (const binding of bindings) {
                if (
                    e.key === binding.key &&
                    (binding.meta === undefined || e.metaKey === binding.meta) &&
                    (binding.ctrl === undefined || e.ctrlKey === binding.ctrl) &&
                    (binding.shift === undefined || e.shiftKey === binding.shift)
                ) {
                    e.preventDefault();
                    binding.action();
                    break;
                }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [bindings]);
}

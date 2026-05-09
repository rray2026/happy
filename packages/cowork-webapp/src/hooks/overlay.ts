import { useEffect } from 'react';

/**
 * Lock document body scroll while `active` is true. Restores the previous
 * inline overflow on cleanup. Used by Modal and the chat sidebar drawer so
 * stacked overlays don't double-undo each other (the latest one wins).
 */
export function useScrollLock(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [active]);
}

/**
 * Run `onEscape` whenever the user presses Escape and `active` is true.
 * Stops propagation so a stacked Esc handler underneath only fires once.
 */
export function useEscape(active: boolean, onEscape: () => void): void {
    useEffect(() => {
        if (!active) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onEscape();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [active, onEscape]);
}

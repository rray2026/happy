import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'error' | 'success';

export interface Toast {
    id: string;
    kind: ToastKind;
    message: string;
    /** Optional click target. Auto-dismisses after invocation. */
    action?: { label: string; onClick: () => void };
}

interface ShowOptions {
    kind?: ToastKind;
    /** Milliseconds before auto-dismiss. Defaults to 5s; 0 disables. */
    ttl?: number;
    action?: { label: string; onClick: () => void };
    /** Optional dedup key — if set, replaces an existing toast with the same key
     *  rather than stacking. Useful for "session X needs permission". */
    key?: string;
}

let toasts: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
    listeners.forEach((l) => l());
}

function snapshot(): Toast[] {
    return toasts;
}

function clearTimer(id: string): void {
    const t = timers.get(id);
    if (t) {
        clearTimeout(t);
        timers.delete(id);
    }
}

export function showToast(message: string, opts: ShowOptions = {}): string {
    const id = opts.key ?? `t-${++nextId}`;
    if (opts.key) {
        clearTimer(id);
        const idx = toasts.findIndex((t) => t.id === id);
        const next: Toast = { id, kind: opts.kind ?? 'info', message, action: opts.action };
        if (idx >= 0) {
            toasts = [...toasts];
            toasts[idx] = next;
        } else {
            toasts = [...toasts, next];
        }
    } else {
        toasts = [...toasts, { id, kind: opts.kind ?? 'info', message, action: opts.action }];
    }
    const ttl = opts.ttl ?? 5000;
    if (ttl > 0) {
        timers.set(id, setTimeout(() => dismissToast(id), ttl));
    }
    emit();
    return id;
}

export function dismissToast(id: string): void {
    clearTimer(id);
    const next = toasts.filter((t) => t.id !== id);
    if (next.length === toasts.length) return;
    toasts = next;
    emit();
}

export function subscribeToasts(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getToasts(): Toast[] {
    return snapshot();
}

export function useToasts(): Toast[] {
    return useSyncExternalStore(subscribeToasts, snapshot, snapshot);
}

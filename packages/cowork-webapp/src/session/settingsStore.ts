import { useSyncExternalStore } from 'react';

/**
 * Lightweight key/value settings store backed by a single `cowork:settings`
 * localStorage entry. Subscribers re-render via useSyncExternalStore the
 * moment any setting changes — same pattern as nameStore, just generic.
 *
 * Keep keys flat and primitive-typed; if a setting needs structure, give it
 * its own dedicated store.
 */
const KEY = 'cowork:settings';

export interface Settings {
    /** BCP-47 language tag for SpeechRecognition. Empty means "use navigator.language". */
    voiceLang?: string;
}

let cache: Settings | null = null;
const listeners = new Set<() => void>();

function read(): Settings {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Settings;
    } catch {
        return {};
    }
}

export function loadSettings(): Settings {
    if (cache === null) cache = read();
    return cache;
}

export function updateSettings(patch: Partial<Settings>): void {
    const next: Settings = { ...loadSettings(), ...patch };
    // Drop empty-string optional fields so the persisted JSON stays compact.
    for (const k of Object.keys(next) as (keyof Settings)[]) {
        if (next[k] === '' || next[k] === undefined) delete next[k];
    }
    cache = next;
    try {
        localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // localStorage quota etc. — in-memory cache still propagates below.
    }
    listeners.forEach((l) => l());
}

export function subscribeSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useSettings(): Settings {
    return useSyncExternalStore(subscribeSettings, loadSettings, loadSettings);
}

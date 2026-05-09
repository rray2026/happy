import { useSyncExternalStore } from 'react';

const KEY = 'cowork:session-names';

type NamesMap = Record<string, string>;
type Listener = () => void;

let cache: NamesMap | null = null;
const listeners = new Set<Listener>();

function read(): NamesMap {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '{}') as NamesMap;
    } catch {
        return {};
    }
}

/**
 * Names map. Cached so subscribers can re-read without paying a JSON.parse
 * each time, and so `useSyncExternalStore` returns a stable reference.
 */
export function loadNames(): NamesMap {
    if (cache === null) cache = read();
    return cache;
}

export function saveName(id: string, name: string): void {
    const map = { ...loadNames() };
    const trimmed = name.trim();
    if (trimmed) map[id] = trimmed;
    else delete map[id];
    try {
        localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
        // Ignore quota/serialization errors — the in-memory update still
        // propagates to subscribers below.
    }
    cache = map;
    listeners.forEach((l) => l());
}

export function subscribeNames(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** React binding. Components automatically re-render on saveName. */
export function useNames(): NamesMap {
    return useSyncExternalStore(subscribeNames, loadNames, loadNames);
}

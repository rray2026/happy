/**
 * Per-session input draft persistence. Plain localStorage wrapper — no
 * pub/sub: drafts are only consumed by the ChatScreen that owns the input,
 * and that consumer reloads explicitly when the active session changes.
 *
 * Storage shape: a single JSON object keyed by chat session id, so cleanup is
 * a single delete on session close (handled implicitly when the user starts
 * a new draft for a different sid — stale entries cost ~bytes).
 */
const KEY = 'cowork:drafts';

type DraftMap = Record<string, string>;

function read(): DraftMap {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '{}') as DraftMap;
    } catch {
        return {};
    }
}

function write(map: DraftMap): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
        // localStorage may throw on quota — a lost draft is acceptable; logging
        // it would be noise.
    }
}

export function getDraft(sessionId: string): string {
    return read()[sessionId] ?? '';
}

export function setDraft(sessionId: string, text: string): void {
    const map = read();
    if (text) {
        if (map[sessionId] === text) return;
        map[sessionId] = text;
    } else if (map[sessionId] !== undefined) {
        delete map[sessionId];
    } else {
        return;
    }
    write(map);
}

export function clearDraft(sessionId: string): void {
    setDraft(sessionId, '');
}

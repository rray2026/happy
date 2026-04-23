const KEY = 'cowork:session-names';

export function loadNames(): Record<string, string> {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
    } catch {
        return {};
    }
}

export function saveName(id: string, name: string): void {
    try {
        const map = loadNames();
        const trimmed = name.trim();
        if (trimmed) map[id] = trimmed;
        else delete map[id];
        localStorage.setItem(KEY, JSON.stringify(map));
    } catch {}
}

import { Settings, settingsDefaults, settingsParse } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

function lsGet(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch {}
}
function lsRemove(key: string): void {
    try { localStorage.removeItem(key); } catch {}
}

export function loadSettings(): { settings: Settings; version: number | null } {
    const raw = lsGet('settings');
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            return { settings: settingsParse(parsed.settings), version: parsed.version ?? null };
        } catch {}
    }
    return { settings: { ...settingsDefaults }, version: null };
}

export function saveSettings(settings: Settings, version: number): void {
    lsSet('settings', JSON.stringify({ settings, version }));
}

export function loadLocalSettings(): LocalSettings {
    const raw = lsGet('local-settings');
    if (raw) {
        try {
            return localSettingsParse(JSON.parse(raw));
        } catch {}
    }
    return { ...localSettingsDefaults };
}

export function saveLocalSettings(settings: LocalSettings): void {
    lsSet('local-settings', JSON.stringify(settings));
}

export function loadSessionDrafts(): Record<string, string> {
    const raw = lsGet('session-drafts');
    if (raw) {
        try { return JSON.parse(raw); } catch {}
    }
    return {};
}

export function saveSessionDrafts(drafts: Record<string, string>): void {
    lsSet('session-drafts', JSON.stringify(drafts));
}

export function loadRegisteredPushToken(): string | null {
    return lsGet('registered-push-token-v1');
}

export function saveRegisteredPushToken(token: string): void {
    lsSet('registered-push-token-v1', token);
}

export function clearPersistence(): void {
    lsRemove('settings');
    lsRemove('local-settings');
    lsRemove('session-drafts');
    lsRemove('registered-push-token-v1');
}

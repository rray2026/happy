import type { StoredCredentials } from '../types';

const CREDS_KEY = 'cowork_direct_creds';
const WEBAPP_KEY = 'cowork_webapp_key';

/**
 * Abstraction over credential persistence. The default implementation uses
 * `localStorage`; tests inject an in-memory version.
 */
export interface CredentialStorage {
    loadCredentials(): StoredCredentials | null;
    saveCredentials(creds: StoredCredentials): void;
    clearCredentials(): void;
    getOrCreateWebappKey(): string;
}

export function createBrowserStorage(): CredentialStorage {
    return {
        loadCredentials() {
            const raw = localStorage.getItem(CREDS_KEY);
            if (!raw) return null;
            try { return JSON.parse(raw) as StoredCredentials; } catch { return null; }
        },
        saveCredentials(creds) {
            localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
        },
        clearCredentials() {
            localStorage.removeItem(CREDS_KEY);
        },
        getOrCreateWebappKey() {
            let key = localStorage.getItem(WEBAPP_KEY);
            if (!key) {
                key = Array.from(crypto.getRandomValues(new Uint8Array(32)))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
                localStorage.setItem(WEBAPP_KEY, key);
            }
            return key;
        },
    };
}

/**
 * In-memory storage intended for tests. Not exported from the package barrel.
 */
export function createMemoryStorage(seed?: {
    creds?: StoredCredentials | null;
    webappKey?: string;
}): CredentialStorage {
    let creds = seed?.creds ?? null;
    let key = seed?.webappKey ?? '';
    return {
        loadCredentials: () => creds,
        saveCredentials: (c) => { creds = c; },
        clearCredentials: () => { creds = null; },
        getOrCreateWebappKey: () => {
            if (!key) key = 'test-webapp-key';
            return key;
        },
    };
}

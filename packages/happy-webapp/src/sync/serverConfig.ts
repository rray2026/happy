const SERVER_KEY = 'happy-custom-server-url';
const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';

export function getServerUrl(): string {
    return localStorage.getItem(SERVER_KEY)
        ?? (import.meta.env.VITE_HAPPY_SERVER_URL as string | undefined)
        ?? DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string | null): void {
    if (url?.trim()) {
        localStorage.setItem(SERVER_KEY, url.trim());
    } else {
        localStorage.removeItem(SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url?.trim()) return { valid: false, error: 'Server URL cannot be empty' };
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}

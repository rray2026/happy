// localStorage-backed drop-in replacement for react-native-mmkv (web only)
export class MMKV {
    private prefix: string;

    constructor(options?: { id?: string }) {
        this.prefix = options?.id ? `mmkv_${options.id}_` : 'mmkv_default_';
    }

    getString(key: string): string | undefined {
        return localStorage.getItem(this.prefix + key) ?? undefined;
    }

    getNumber(key: string): number | undefined {
        const v = localStorage.getItem(this.prefix + key);
        return v !== null ? Number(v) : undefined;
    }

    set(key: string, value: string | number | boolean): void {
        localStorage.setItem(this.prefix + key, String(value));
    }

    delete(key: string): void {
        localStorage.removeItem(this.prefix + key);
    }

    clearAll(): void {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(this.prefix)) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
    }
}

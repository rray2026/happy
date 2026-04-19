const AUTH_KEY = 'auth_credentials';

export interface AuthCredentials {
    token: string;
    secret: string;
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        const raw = localStorage.getItem(AUTH_KEY);
        if (!raw) return null;
        try {
            return JSON.parse(raw) as AuthCredentials;
        } catch {
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        localStorage.setItem(AUTH_KEY, JSON.stringify(credentials));
        return true;
    },

    async removeCredentials(): Promise<boolean> {
        localStorage.removeItem(AUTH_KEY);
        return true;
    },
};

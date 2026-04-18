import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const AUTH_KEY = 'auth_credentials';
const DIRECT_KEY = 'direct_credentials';

export interface DirectCredentials {
    endpoint: string;
    cliPublicKey: string;
    sessionId: string;
    sessionCredential: string;
    lastSeq: number;
    webappPublicKey: string;
}

// Cache for synchronous access
let credentialsCache: string | null = null;

export interface AuthCredentials {
    token: string;
    secret: string;
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        if (Platform.OS === 'web') {
            return localStorage.getItem(AUTH_KEY) ? JSON.parse(localStorage.getItem(AUTH_KEY)!) as AuthCredentials : null;
        }
        try {
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return null;
            credentialsCache = stored; // Update cache
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        if (Platform.OS === 'web') {
            localStorage.setItem(AUTH_KEY, JSON.stringify(credentials));
            return true;
        }
        try {
            const json = JSON.stringify(credentials);
            await SecureStore.setItemAsync(AUTH_KEY, json);
            credentialsCache = json; // Update cache
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        if (Platform.OS === 'web') {
            localStorage.removeItem(AUTH_KEY);
            return true;
        }
        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
            credentialsCache = null; // Clear cache
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },

    // Direct credentials are web-only (localStorage) — direct connect is a webapp feature
    getDirectCredentials(): DirectCredentials | null {
        if (Platform.OS !== 'web') return null;
        const raw = localStorage.getItem(DIRECT_KEY);
        if (!raw) return null;
        try {
            return JSON.parse(raw) as DirectCredentials;
        } catch {
            return null;
        }
    },

    setDirectCredentials(creds: DirectCredentials): void {
        if (Platform.OS !== 'web') return;
        localStorage.setItem(DIRECT_KEY, JSON.stringify(creds));
    },

    removeDirectCredentials(): void {
        if (Platform.OS !== 'web') return;
        localStorage.removeItem(DIRECT_KEY);
    },
};
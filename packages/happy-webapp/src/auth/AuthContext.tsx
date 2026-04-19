import React, { createContext, useContext, useState, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from './tokenStorage';
import { syncCreate } from '@/sync/sync';
import { clearPersistence } from '@/sync/persistence';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

let currentAuthState: AuthContextType | null = null;

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}

export function AuthProvider({
    children,
    initialCredentials,
}: {
    children: ReactNode;
    initialCredentials: AuthCredentials | null;
}) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);

    const login = async (token: string, secret: string) => {
        const newCredentials: AuthCredentials = { token, secret };
        const success = await TokenStorage.setCredentials(newCredentials);
        if (!success) throw new Error('Failed to save credentials');
        await syncCreate(newCredentials);
        setCredentials(newCredentials);
        setIsAuthenticated(true);
        currentAuthState = { isAuthenticated: true, credentials: newCredentials, login, logout };
    };

    const logout = async () => {
        clearPersistence();
        await TokenStorage.removeCredentials();
        setCredentials(null);
        setIsAuthenticated(false);
        currentAuthState = null;
        window.location.reload();
    };

    React.useEffect(() => {
        currentAuthState = credentials
            ? { isAuthenticated, credentials, login, logout }
            : null;
    }, [isAuthenticated, credentials]);

    return (
        <AuthContext.Provider value={{ isAuthenticated, credentials, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}

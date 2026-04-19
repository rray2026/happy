import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { AuthProvider } from '@/auth/AuthContext';
import { ModalProvider } from '@/modal/ModalProvider';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncRestore } from '@/sync/sync';

export function RootLayout() {
    const [initState, setInitState] = useState<{ credentials: AuthCredentials | null } | null>(null);

    useEffect(() => {
        (async () => {
            const credentials = await TokenStorage.getCredentials();
            if (credentials) {
                await syncRestore(credentials);
            }
            setInitState({ credentials });
        })();
    }, []);

    if (!initState) {
        return (
            <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface)' }}>
                <div style={{ width: 32, height: 32, border: '3px solid var(--color-divider)', borderTopColor: 'var(--color-text)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
        );
    }

    return (
        <ThemeProvider>
            <AuthProvider initialCredentials={initState.credentials}>
                <ModalProvider>
                    <Outlet />
                </ModalProvider>
            </AuthProvider>
        </ThemeProvider>
    );
}

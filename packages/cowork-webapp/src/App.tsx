import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ConnectScreen } from './components/ConnectScreen';
import { ChatScreen } from './components/ChatScreen';
import { TabBar } from './components/TabBar';
import { SessionListPage } from './components/SessionListPage';
import { SettingsPage } from './components/SettingsPage';
import { sessionClient } from './session';

function AppRoutes() {
    const location = useLocation();
    // Hide tab bar on the connect screen (no app context yet) and inside a
    // specific chat session (chat owns the full viewport).
    const hideTabs = location.pathname === '/' || /^\/sessions\/[^/]+/.test(location.pathname);

    return (
        <>
            {!hideTabs && <TabBar />}
            <Routes>
                <Route path="/" element={<ConnectScreen />} />
                <Route path="/sessions" element={<SessionListPage />} />
                <Route path="/sessions/:sessionId" element={<ChatScreen />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </>
    );
}

export function App() {
    // Auto-connect on startup when stored credentials exist.
    useEffect(() => {
        if (sessionClient.getStatus() === 'disconnected') {
            const creds = sessionClient.loadStoredCredentials();
            if (creds) sessionClient.connectFromStored(creds);
        }
    }, []);

    return <AppRoutes />;
}

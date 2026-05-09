import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ConnectScreen } from './components/ConnectScreen';
import { ChatScreen } from './components/ChatScreen';
import { TabBar } from './components/TabBar';
import { SessionListPage } from './components/SessionListPage';
import { SettingsPage } from './components/SettingsPage';
import { ToastViewport } from './components/ToastViewport';
import { sessionClient } from './session';
import { useNames } from './session/nameStore';
import { defaultName } from './session/displayHelpers';
import { showToast } from './toast/toastStore';

function AppRoutes() {
    const location = useLocation();
    const navigate = useNavigate();
    const names = useNames();
    // Hide tab bar on the connect screen (no app context yet) and inside a
    // specific chat session (chat owns the full viewport).
    const hideTabs = location.pathname === '/' || /^\/sessions\/[^/]+/.test(location.pathname);

    // Surface permission requests landing on non-active sessions as a toast
    // with a "前往" action. The active session's ChatScreen already shows a
    // modal directly, so suppress the toast in that case.
    useEffect(() => {
        return sessionClient.onPermissionRequested((sid) => {
            if (location.pathname === `/sessions/${sid}`) return;
            const meta = sessionClient.getSessions().find((s) => s.id === sid);
            const label = names[sid] ?? (meta ? defaultName(meta) : sid.slice(0, 8));
            showToast(`${label} 等待你的授权`, {
                kind: 'info',
                key: `perm-${sid}`,
                ttl: 0,
                action: { label: '前往', onClick: () => navigate(`/sessions/${sid}`) },
            });
        });
    }, [location.pathname, names, navigate]);

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
            <ToastViewport />
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

import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { ConnectScreen } from './components/ConnectScreen';
import { ChatScreen } from './components/ChatScreen';
import { ChatLanding } from './components/ChatLanding';
import { TabBar } from './components/TabBar';
import { HomePage } from './components/HomePage';
import { SessionListPage } from './components/SessionListPage';
import { SettingsPage } from './components/SettingsPage';
import { sessionClient } from './session';

function AppRoutes() {
    const location = useLocation();
    // Hide tab bar when inside a specific chat session
    const hideTabs = /^\/sessions\/[^/]+/.test(location.pathname);

    return (
        <>
            <Routes>
                <Route path="/" element={<ConnectScreen />} />
                <Route path="/home" element={<HomePage />} />
                <Route path="/sessions" element={<SessionListPage />} />
                <Route path="/sessions/:sessionId" element={<ChatScreenRoute />} />
                <Route path="/settings" element={<SettingsPage />} />
                {/* Legacy routes */}
                <Route path="/chat" element={<Navigate to="/sessions" replace />} />
                <Route path="/chat/:sessionId" element={<ChatLandingRedirect />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            {!hideTabs && <TabBar />}
        </>
    );
}

function ChatLandingRedirect() {
    const location = useLocation();
    const id = location.pathname.replace('/chat/', '');
    return <Navigate to={`/sessions/${id}`} replace />;
}

// Wrap ChatScreen with key=sessionId so React re-mounts it on session switch,
// resetting all state and refs without needing an effect.
function ChatScreenRoute() {
    const { sessionId } = useParams<{ sessionId: string }>();
    return <ChatScreen key={sessionId} />;
}

// ChatLanding is still used on desktop (sidebar layout) when navigating to /sessions
// with no specific session selected. Keep it available for the sidebar's goto('/chat') calls.
export { ChatLanding };

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

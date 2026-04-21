import { Routes, Route, Navigate } from 'react-router-dom'
import { ConnectScreen } from './components/ConnectScreen'
import { ChatScreen } from './components/ChatScreen'
import { ChatLanding } from './components/ChatLanding'

export function App() {
    return (
        <Routes>
            <Route path="/" element={<ConnectScreen />} />
            <Route path="/chat" element={<ChatLanding />} />
            <Route path="/chat/:sessionId" element={<ChatScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    )
}

import { useNavigate } from 'react-router';

export function useNavigateToSession() {
    const navigate = useNavigate();
    return (sessionId: string) => navigate(`/session/${sessionId}`);
}

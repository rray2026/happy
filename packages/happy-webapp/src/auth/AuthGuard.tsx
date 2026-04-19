import { Navigate, Outlet } from 'react-router';
import { useAuth } from './AuthContext';

export function AuthGuard() {
    const { isAuthenticated } = useAuth();
    if (!isAuthenticated) return <Navigate to="/" replace />;
    return <Outlet />;
}

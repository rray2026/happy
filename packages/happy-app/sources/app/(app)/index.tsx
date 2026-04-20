import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';

export default function Index() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <Redirect href="/terminal" />;
    }
    return <Redirect href="/direct" />;
}

import { useLocation, useNavigate } from 'react-router-dom';
import { Home, MessagesSquare, Settings } from 'lucide-react';

const TABS = [
    { path: '/home', label: '首页', Icon: Home },
    { path: '/sessions', label: '会话', Icon: MessagesSquare },
    { path: '/settings', label: '设置', Icon: Settings },
] as const;

export function TabBar() {
    const location = useLocation();
    const navigate = useNavigate();

    const active = (path: string) =>
        location.pathname === path || (path === '/sessions' && location.pathname.startsWith('/sessions'));

    return (
        <nav className="tab-bar" aria-label="主导航">
            {TABS.map(({ path, label, Icon }) => (
                <button
                    key={path}
                    type="button"
                    className={`tab-bar-item${active(path) ? ' active' : ''}`}
                    onClick={() => navigate(path)}
                    aria-label={label}
                    aria-current={active(path) ? 'page' : undefined}
                >
                    <Icon size={24} className="tab-bar-icon" />
                    <span className="tab-bar-label">{label}</span>
                </button>
            ))}
        </nav>
    );
}

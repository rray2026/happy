import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessagesSquare, Settings } from 'lucide-react';
import { sessionClient } from '../session';
import type { SocketStatus } from '../types';

const TABS = [
    { path: '/sessions', label: '会话', Icon: MessagesSquare },
    { path: '/settings', label: '设置', Icon: Settings },
] as const;

const STATUS_DOT: Record<SocketStatus, string> = {
    connected: 'dot-green',
    connecting: 'dot-orange',
    error: 'dot-red',
    disconnected: 'dot-gray',
};

const STATUS_LABEL: Record<SocketStatus, string> = {
    connected: '已连接',
    connecting: '连接中…',
    error: '连接错误',
    disconnected: '未连接',
};

export function TabBar() {
    const location = useLocation();
    const navigate = useNavigate();
    const [status, setStatus] = useState<SocketStatus>(sessionClient.getStatus());

    useEffect(() => sessionClient.onStatusChange(setStatus), []);

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
            <div
                className="tab-bar-status"
                role="status"
                aria-label={STATUS_LABEL[status]}
                title={STATUS_LABEL[status]}
            >
                <span className={`status-dot ${STATUS_DOT[status]}`} aria-hidden="true" />
                <span className="tab-bar-status-label">{STATUS_LABEL[status]}</span>
            </div>
        </nav>
    );
}

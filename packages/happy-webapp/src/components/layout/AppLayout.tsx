import React, { memo } from 'react';
import { Outlet, useLocation, Link } from 'react-router';
import { Sidebar } from './Sidebar';

export const AppLayout = memo(function AppLayout() {
    const location = useLocation();

    const mobileNavItems = [
        { to: '/', label: 'Sessions', icon: '💻' },
        { to: '/inbox', label: 'Inbox', icon: '📬' },
        { to: '/settings', label: 'Settings', icon: '⚙️' },
    ];

    return (
        <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--color-surface)' }}>
            {/* Sidebar — hidden on mobile */}
            <div style={{ display: 'none' }} className="sidebar-desktop">
                <Sidebar />
            </div>
            <style>{`
                @media (min-width: 768px) {
                    .sidebar-desktop { display: flex !important; }
                    .mobile-tabbar { display: none !important; }
                }
            `}</style>

            {/* Main content */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <Outlet />
                </div>

                {/* Mobile bottom tab bar */}
                <div
                    className="mobile-tabbar"
                    style={{
                        display: 'flex',
                        borderTop: '1px solid var(--color-divider)',
                        background: 'var(--color-surface-high)',
                    }}
                >
                    {mobileNavItems.map(item => {
                        const isActive = item.to === '/'
                            ? location.pathname === '/' || location.pathname.startsWith('/session')
                            : location.pathname.startsWith(item.to);
                        return (
                            <Link
                                key={item.to}
                                to={item.to}
                                style={{
                                    flex: 1, display: 'flex', flexDirection: 'column',
                                    alignItems: 'center', justifyContent: 'center',
                                    padding: '8px 0 4px', textDecoration: 'none',
                                    color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)',
                                    fontSize: 10, gap: 2,
                                }}
                            >
                                <span style={{ fontSize: 20 }}>{item.icon}</span>
                                <span>{item.label}</span>
                            </Link>
                        );
                    })}
                </div>
            </div>
        </div>
    );
});

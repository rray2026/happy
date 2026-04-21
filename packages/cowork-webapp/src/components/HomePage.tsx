import { useState, useEffect } from 'react';
import { sessionClient } from '../session';
import type { SocketStatus } from '../types';

export function HomePage() {
    const [status, setStatus] = useState<SocketStatus>(sessionClient.getStatus());

    useEffect(() => sessionClient.onStatusChange(setStatus), []);

    const statusDot = status === 'connected' ? 'dot-green'
        : status === 'connecting' ? 'dot-orange'
        : status === 'error' ? 'dot-red'
        : 'dot-gray';

    return (
        <div className="home-page tab-page">
            <div className="home-content">
                <div className="home-logo">⚡</div>
                <h1 className="home-title">Cowork</h1>
                <div className="home-status">
                    <span className={`status-dot ${statusDot}`} aria-hidden="true" />
                    <span className="home-status-label">
                        {status === 'connected' ? '已连接'
                            : status === 'connecting' ? '连接中…'
                            : status === 'error' ? '连接错误'
                            : '未连接'}
                    </span>
                </div>
            </div>
        </div>
    );
}

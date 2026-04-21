import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionClient } from '../session';
import type { DirectQRPayload, StoredCredentials } from '../types';
import { SessionTransferModal } from './SessionTransferModal';

export function ConnectScreen() {
    const navigate = useNavigate();
    const [stored, setStored] = useState<StoredCredentials | null>(() => sessionClient.loadStoredCredentials());
    const [resuming, setResuming] = useState(false);
    const [resumeError, setResumeError] = useState('');

    const [text, setText] = useState('');
    const [connectError, setConnectError] = useState('');
    const [connecting, setConnecting] = useState(false);

    const [transferOpen, setTransferOpen] = useState(false);

    // ── Resume ────────────────────────────────────────────────────────────────

    const handleResume = () => {
        if (!stored) return;
        setResumeError('');
        setResuming(true);

        let unsub: (() => void) | null = null;
        unsub = sessionClient.onStatusChange((status) => {
            if (status === 'connected') {
                unsub?.();
                setResuming(false);
                navigate('/chat');
            } else if (status === 'error') {
                unsub?.();
                setResuming(false);
                setResumeError(sessionClient.getLastError() ?? 'Reconnection failed.');
            }
        });

        sessionClient.connectFromStored(stored);
    };

    const handleForget = () => {
        sessionClient.disconnect();
        sessionClient.clearCredentials();
        setStored(null);
        setResumeError('');
    };

    // ── New connection ────────────────────────────────────────────────────────

    const handleConnect = () => {
        setConnectError('');
        let payload: DirectQRPayload;
        try {
            payload = JSON.parse(text.trim()) as DirectQRPayload;
        } catch {
            setConnectError('无效的 JSON，请粘贴 CLI 打印的完整 payload。');
            return;
        }
        if (payload.type !== 'direct' || !payload.endpoint || !payload.nonce) {
            setConnectError('不是有效的 Direct Connect payload。');
            return;
        }
        if (Date.now() > payload.nonceExpiry) {
            setConnectError('QR code 已过期，请重新运行 `cowork-agent serve`。');
            return;
        }

        setConnecting(true);
        const webappKey = sessionClient.getOrCreateWebappKey();

        let unsub: (() => void) | null = null;
        unsub = sessionClient.onStatusChange((status) => {
            if (status === 'connected') {
                unsub?.();
                setConnecting(false);
                navigate('/chat');
            } else if (status === 'error') {
                unsub?.();
                setConnecting(false);
                setConnectError(sessionClient.getLastError() ?? 'Connection failed.');
            }
        });

        sessionClient.connectFirstTime(payload, webappKey);
    };

    // ── Transfer ──────────────────────────────────────────────────────────────

    const handleImported = () => {
        setStored(sessionClient.loadStoredCredentials());
        setTransferOpen(false);
    };

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="connect-screen">
            <div className="connect-card">
                <div className="connect-logo">⚡</div>
                <h1 className="connect-title">Cowork</h1>

                <button className="transfer-entry-btn" onClick={() => setTransferOpen(true)}>
                    ⇄ Session 迁移（导入 / 导出）
                </button>

                {stored && (
                    <>
                        <div className="resume-section">
                            <div className="resume-label">上次连接</div>
                            <div className="resume-endpoint">{stored.endpoint}</div>
                            <div className="resume-meta">
                                Session&nbsp;<span className="resume-id">{stored.sessionId.slice(0, 8)}…</span>
                            </div>
                            {resumeError && <p className="connect-error">{resumeError}</p>}
                            <div className="resume-actions">
                                <button
                                    type="button"
                                    className="btn btn-primary btn-lg"
                                    onClick={handleResume}
                                    disabled={resuming}
                                >
                                    {resuming ? '连接中…' : '恢复连接'}
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={handleForget}
                                    disabled={resuming}
                                >
                                    忘记
                                </button>
                            </div>
                        </div>

                        <div className="connect-divider"><span>或建立新连接</span></div>
                    </>
                )}

                {!stored && (
                    <p className="connect-subtitle">
                        在终端运行 <code>cowork-agent serve</code>，然后将打印的 JSON payload 粘贴到下方。
                    </p>
                )}

                <textarea
                    className="connect-textarea"
                    value={text}
                    onChange={e => { setText(e.target.value); setConnectError(''); }}
                    placeholder={'{\n  "type": "direct",\n  "endpoint": "ws://...",\n  ...\n}'}
                    rows={6}
                    disabled={connecting}
                    spellCheck={false}
                />
                {connectError && <p className="connect-error">{connectError}</p>}
                <button
                    type="button"
                    className="btn btn-primary btn-lg btn-block"
                    onClick={handleConnect}
                    disabled={!text.trim() || connecting}
                >
                    {connecting ? '连接中…' : '新建连接'}
                </button>
            </div>

            {transferOpen && (
                <SessionTransferModal
                    onClose={() => setTransferOpen(false)}
                    onImported={handleImported}
                />
            )}
        </div>
    );
}

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { directSocket, loadStoredCredentials, clearCredentials, getOrCreateWebappKey, type DirectQRPayload, type StoredCredentials } from '../directSocket';

const STORAGE_KEY = 'cowork_direct_creds';

export function ConnectScreen() {
    const navigate = useNavigate();
    const [stored, setStored] = useState<StoredCredentials | null>(null);
    const [resuming, setResuming] = useState(false);
    const [resumeError, setResumeError] = useState('');

    const [text, setText] = useState('');
    const [connectError, setConnectError] = useState('');
    const [connecting, setConnecting] = useState(false);

    const [exportJson, setExportJson] = useState<string | null>(null);
    const [importText, setImportText] = useState('');
    const [importError, setImportError] = useState('');
    const [copied, setCopied] = useState(false);
    const [transferOpen, setTransferOpen] = useState(false);

    useEffect(() => {
        setStored(loadStoredCredentials());
    }, []);

    // ── Resume ────────────────────────────────────────────────────────────────

    const handleResume = () => {
        if (!stored) return;
        setResumeError('');
        setResuming(true);

        let unsub: (() => void) | null = null;
        unsub = directSocket.onStatusChange((status) => {
            if (status === 'connected') {
                unsub?.();
                setResuming(false);
                navigate('/chat');
            } else if (status === 'error') {
                unsub?.();
                setResuming(false);
                setResumeError(directSocket.getLastError() ?? 'Reconnection failed.');
            }
        });

        directSocket.connectFromStored({ ...stored, lastSeq: -1 });
    };

    const handleForget = () => {
        directSocket.disconnect();
        clearCredentials();
        setStored(null);
        setResumeError('');
        setExportJson(null);
        setTransferOpen(false);
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
            setConnectError('QR code 已过期，请重新运行 `happy serve`。');
            return;
        }

        setConnecting(true);
        const webappKey = getOrCreateWebappKey();

        let unsub: (() => void) | null = null;
        unsub = directSocket.onStatusChange((status) => {
            if (status === 'connected') {
                unsub?.();
                setConnecting(false);
                navigate('/chat');
            } else if (status === 'error') {
                unsub?.();
                setConnecting(false);
                setConnectError(directSocket.getLastError() ?? 'Connection failed.');
            }
        });

        directSocket.connectFirstTime(payload, webappKey);
    };

    // ── Export / Import ───────────────────────────────────────────────────────

    const handleExport = useCallback(() => {
        const creds = loadStoredCredentials();
        setExportJson(creds ? JSON.stringify(creds, null, 2) : null);
    }, []);

    const handleCopy = useCallback(async () => {
        if (!exportJson) return;
        await navigator.clipboard.writeText(exportJson);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [exportJson]);

    const handleImport = useCallback(() => {
        setImportError('');
        const raw = importText.trim();
        if (!raw) { setImportError('请先粘贴 Session JSON。'); return; }

        let creds: Record<string, unknown>;
        try { creds = JSON.parse(raw) as Record<string, unknown>; }
        catch { setImportError('无法解析 JSON，请检查格式。'); return; }

        if (!creds['endpoint'] || !creds['sessionCredential'] || !creds['webappPublicKey']) {
            setImportError('缺少必要字段（endpoint / sessionCredential / webappPublicKey）。');
            return;
        }

        const imported = { ...creds, lastSeq: (creds['lastSeq'] as number) ?? -1 } as StoredCredentials;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
        setStored(imported);
        setImportText('');
        setTransferOpen(false);
    }, [importText]);

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="connect-screen">
            <div className="connect-card">
                <div className="connect-logo">⚡</div>
                <h1 className="connect-title">Cowork</h1>

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
                                <button className="connect-btn resume-btn" onClick={handleResume} disabled={resuming}>
                                    {resuming ? '连接中…' : '恢复连接'}
                                </button>
                                <button
                                    className="forget-btn"
                                    onClick={() => { setTransferOpen(o => !o); if (!transferOpen) handleExport(); }}
                                    disabled={resuming}
                                >
                                    迁移
                                </button>
                                <button className="forget-btn" onClick={handleForget} disabled={resuming}>
                                    忘记
                                </button>
                            </div>
                        </div>

                        {transferOpen && (
                            <div className="transfer-panel">
                                <div className="transfer-section-title">导出 — 将此 Session 迁移到其他浏览器</div>
                                {exportJson
                                    ? (
                                        <div className="transfer-json-box">
                                            <pre className="transfer-json">{exportJson}</pre>
                                            <button className="transfer-copy-btn" onClick={handleCopy}>
                                                {copied ? '✓ 已复制' : '复制到剪贴板'}
                                            </button>
                                        </div>
                                    )
                                    : <p className="transfer-hint-error">未找到已保存的 Session。</p>
                                }
                                <div className="transfer-divider" />
                                <div className="transfer-section-title">导入 — 从其他浏览器导入 Session</div>
                                <textarea
                                    className="transfer-textarea"
                                    value={importText}
                                    onChange={e => { setImportText(e.target.value); setImportError(''); }}
                                    placeholder="粘贴从其他浏览器导出的 Session JSON…"
                                    rows={4}
                                    spellCheck={false}
                                />
                                {importError && <p className="connect-error">{importError}</p>}
                                <button
                                    className="transfer-import-btn"
                                    onClick={handleImport}
                                    disabled={!importText.trim()}
                                >
                                    导入
                                </button>
                            </div>
                        )}

                        <div className="connect-divider"><span>或建立新连接</span></div>
                    </>
                )}

                {!stored && (
                    <p className="connect-subtitle">
                        在终端运行 <code>happy serve</code>，然后将打印的 JSON payload 粘贴到下方。
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
                <button className="connect-btn" onClick={handleConnect} disabled={!text.trim() || connecting}>
                    {connecting ? '连接中…' : '新建连接'}
                </button>
            </div>
        </div>
    );
}

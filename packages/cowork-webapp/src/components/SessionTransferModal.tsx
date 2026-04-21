import { useState, useCallback } from 'react';
import { sessionClient } from '../session';
import type { StoredCredentials } from '../types';

interface Props {
    onClose: () => void;
    onImported: () => void;
}

export function SessionTransferModal({ onClose, onImported }: Props) {
    const [exportJson, setExportJson] = useState<string | null>(null);
    const [importText, setImportText] = useState('');
    const [importError, setImportError] = useState('');
    const [copied, setCopied] = useState(false);

    const handleExport = useCallback(() => {
        const creds = sessionClient.loadStoredCredentials();
        if (!creds) {
            setExportJson(null);
            return;
        }
        setExportJson(JSON.stringify(creds, null, 2));
    }, []);

    const handleCopy = useCallback(async () => {
        if (!exportJson) return;
        await navigator.clipboard.writeText(exportJson);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [exportJson]);

    const handleImport = useCallback(() => {
        setImportError('');
        const text = importText.trim();
        if (!text) { setImportError('请先粘贴 Session JSON。'); return; }

        let creds: Record<string, unknown>;
        try {
            creds = JSON.parse(text) as Record<string, unknown>;
        } catch {
            setImportError('无法解析 JSON，请检查格式。');
            return;
        }

        if (!creds['endpoint'] || !creds['sessionCredential'] || !creds['webappPublicKey']) {
            setImportError('缺少必要字段（endpoint / sessionCredential / webappPublicKey）。');
            return;
        }

        const rawLastSeqs =
            creds['lastSeqs'] && typeof creds['lastSeqs'] === 'object'
                ? (creds['lastSeqs'] as Record<string, number>)
                : {};
        const imported: StoredCredentials = {
            endpoint: String(creds['endpoint']),
            cliPublicKey: String(creds['cliPublicKey'] ?? ''),
            sessionId: String(creds['sessionId'] ?? ''),
            sessionCredential: String(creds['sessionCredential']),
            webappPublicKey: String(creds['webappPublicKey']),
            lastSeqs: rawLastSeqs,
        };
        sessionClient.disconnect();
        sessionClient.importCredentials(imported);
        onImported();
    }, [importText, onImported]);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="transfer-card" onClick={e => e.stopPropagation()}>
                <div className="transfer-header">
                    <h3 className="transfer-title">Session 迁移</h3>
                    <button className="logs-close" onClick={onClose}>✕</button>
                </div>

                {/* Export */}
                <section className="transfer-section">
                    <div className="transfer-section-title">导出 — 将当前会话迁移到其他浏览器</div>
                    <button className="transfer-action-btn" onClick={handleExport}>
                        ↓ 载入当前 Session
                    </button>
                    {exportJson !== null && (
                        exportJson ? (
                            <div className="transfer-json-box">
                                <pre className="transfer-json">{exportJson}</pre>
                                <button className="transfer-copy-btn" onClick={handleCopy}>
                                    {copied ? '✓ 已复制' : '复制到剪贴板'}
                                </button>
                            </div>
                        ) : (
                            <p className="transfer-hint-error">当前浏览器没有已保存的 Session。</p>
                        )
                    )}
                </section>

                <div className="transfer-divider" />

                {/* Import */}
                <section className="transfer-section">
                    <div className="transfer-section-title">导入 — 从另一个浏览器导入 Session</div>
                    <textarea
                        className="transfer-textarea"
                        value={importText}
                        onChange={e => { setImportText(e.target.value); setImportError(''); }}
                        placeholder='粘贴从其他浏览器导出的 Session JSON…'
                        rows={5}
                        spellCheck={false}
                    />
                    {importError && <p className="connect-error">{importError}</p>}
                    <button
                        className="transfer-import-btn"
                        onClick={handleImport}
                        disabled={!importText.trim()}
                    >
                        导入并重新连接
                    </button>
                </section>
            </div>
        </div>
    );
}

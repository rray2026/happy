import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info, ScrollText, ArrowLeftRight, LogOut, ChevronRight } from 'lucide-react';
import { sessionClient } from '../session';
import { Modal } from './Modal';
import { LogsModal } from './LogsModal';
import { SessionTransferModal } from './SessionTransferModal';

export function SettingsPage() {
    const navigate = useNavigate();
    const stored = sessionClient.loadStoredCredentials();

    const [logsOpen, setLogsOpen] = useState(false);
    const [transferOpen, setTransferOpen] = useState(false);
    const [confirmDisconnect, setConfirmDisconnect] = useState(false);

    const handleDisconnect = () => {
        sessionClient.disconnect();
        sessionClient.clearCredentials();
        setConfirmDisconnect(false);
        navigate('/');
    };

    return (
        <div className="settings-page tab-page">
            <div className="settings-header">
                <h1 className="settings-title">设置</h1>
            </div>

            {stored && (
                <div className="settings-section">
                    <div className="settings-section-title">
                        <Info size={13} />
                        连接信息
                    </div>
                    <div className="settings-item settings-item-info">
                        <span className="settings-item-label">服务端地址</span>
                        <span className="settings-value">{stored.endpoint}</span>
                    </div>
                    <div className="settings-item settings-item-info">
                        <span className="settings-item-label">Session ID</span>
                        <span className="settings-value">{stored.sessionId.slice(0, 16)}…</span>
                    </div>
                </div>
            )}

            <div className="settings-section">
                <div className="settings-section-title">
                    <ScrollText size={13} />
                    工具
                </div>
                <button
                    type="button"
                    className="settings-item"
                    onClick={() => setLogsOpen(true)}
                >
                    <ScrollText size={18} className="settings-item-icon" />
                    <span className="settings-item-text">查看 CLI 日志</span>
                    <ChevronRight size={16} className="settings-item-chevron" />
                </button>
                <button
                    type="button"
                    className="settings-item"
                    onClick={() => setTransferOpen(true)}
                >
                    <ArrowLeftRight size={18} className="settings-item-icon" />
                    <span className="settings-item-text">Session 迁移</span>
                    <ChevronRight size={16} className="settings-item-chevron" />
                </button>
            </div>

            <div className="settings-section">
                <button
                    type="button"
                    className="settings-item settings-item-danger"
                    onClick={() => setConfirmDisconnect(true)}
                >
                    <LogOut size={18} className="settings-item-icon" />
                    <span className="settings-item-text">断开并清除凭据</span>
                </button>
            </div>

            <LogsModal open={logsOpen} onClose={() => setLogsOpen(false)} />

            {transferOpen && (
                <SessionTransferModal
                    onClose={() => setTransferOpen(false)}
                    onImported={() => setTransferOpen(false)}
                />
            )}

            <Modal
                open={confirmDisconnect}
                title="断开并清除凭据？"
                onClose={() => setConfirmDisconnect(false)}
                size="sm"
            >
                <div className="modal-body">
                    <p className="confirm-text">
                        这会断开当前连接并删除本浏览器里保存的 session 凭据。下次需要重新粘贴 payload。
                    </p>
                    <div className="modal-actions">
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setConfirmDisconnect(false)}
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            className="btn btn-danger"
                            onClick={handleDisconnect}
                        >
                            断开
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}

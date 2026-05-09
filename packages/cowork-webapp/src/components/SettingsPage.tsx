import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info, ScrollText, ArrowLeftRight, LogOut, ChevronRight, Mic } from 'lucide-react';
import { sessionClient } from '../session';
import { Modal } from './Modal';
import { LogsModal } from './LogsModal';
import { SessionTransferModal } from './SessionTransferModal';
import { updateSettings, useSettings } from '../session/settingsStore';
import { isSpeechRecognitionSupported } from '../hooks/voice';

const VOICE_LANG_OPTIONS: ReadonlyArray<{
    label: string;
    options: ReadonlyArray<{ value: string; label: string }>;
}> = [
    {
        label: '中文',
        options: [
            { value: 'zh-CN', label: '普通话（中国大陆）' },
            { value: 'zh-HK', label: '粤语（香港）' },
            { value: 'zh-TW', label: '普通话（台湾）' },
        ],
    },
    {
        label: 'English',
        options: [
            { value: 'en-US', label: 'English (US)' },
            { value: 'en-GB', label: 'English (UK)' },
        ],
    },
    {
        label: '其他',
        options: [
            { value: 'ja-JP', label: '日本語' },
            { value: 'ko-KR', label: '한국어' },
            { value: 'es-ES', label: 'Español' },
            { value: 'fr-FR', label: 'Français' },
            { value: 'de-DE', label: 'Deutsch' },
            { value: 'pt-BR', label: 'Português (Brasil)' },
            { value: 'ru-RU', label: 'Русский' },
        ],
    },
];

export function SettingsPage() {
    const navigate = useNavigate();
    const stored = sessionClient.loadStoredCredentials();
    const settings = useSettings();
    const voiceSupported = isSpeechRecognitionSupported();

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
                    <Mic size={13} />
                    语音输入
                </div>
                <label className="settings-item settings-item-row">
                    <Mic size={18} className="settings-item-icon" />
                    <span className="settings-item-text">识别语言</span>
                    <select
                        className="settings-select"
                        value={settings.voiceLang ?? ''}
                        onChange={(e) => updateSettings({ voiceLang: e.target.value })}
                        disabled={!voiceSupported}
                        aria-label="语音识别语言"
                    >
                        <option value="">自动（系统语言）</option>
                        {VOICE_LANG_OPTIONS.map((group) => (
                            <optgroup key={group.label} label={group.label}>
                                {group.options.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </label>
                {!voiceSupported && (
                    <div className="settings-item-note">
                        当前浏览器不支持 Web Speech API（如 Firefox），切换到 Chrome / Edge / Safari 后可启用麦克风输入。
                    </div>
                )}
            </div>

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

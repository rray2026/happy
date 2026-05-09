import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info, ScrollText, ArrowLeftRight, LogOut, ChevronRight, Mic, Headphones, Play, Square } from 'lucide-react';
import { sessionClient } from '../session';
import { Modal } from './Modal';
import { LogsModal } from './LogsModal';
import { SessionTransferModal } from './SessionTransferModal';
import { SETTINGS_DEFAULTS, updateSettings, useSettings } from '../session/settingsStore';
import { isSpeechRecognitionSupported } from '../hooks/voice';
import { isSpeechSynthesisSupported, useSpeechSynthesis, useTtsVoices } from '../hooks/tts';

/** Short language-typical samples for the voice-preview button. Long enough
 *  that the listener gets a feel for cadence + tone without becoming a
 *  speech itself — picking a voice should be a few seconds of clicking. */
const SAMPLE_ZH = '你好，这是朗读音色试听。';
const SAMPLE_EN = 'Hello, this is a voice preview.';
const SAMPLE_MIXED = '你好，Hello，这是 voice 试听。';

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
    const ttsSupported = isSpeechSynthesisSupported();
    const ttsVoices = useTtsVoices();
    // Filter the voice list down to "matches user's recognition language"
    // when one is set, otherwise show all installed voices. Browsers ship
    // 50+ voices on macOS; the unfiltered list is unwieldy.
    const langPrefix = (settings.voiceLang || '').split('-')[0];
    const filteredVoices = langPrefix
        ? ttsVoices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix.toLowerCase()))
        : ttsVoices;
    const ttsRate = settings.ttsRate ?? SETTINGS_DEFAULTS.ttsRate;
    const ttsRateZh = settings.ttsRateZh ?? ttsRate;
    const ttsRateEn = settings.ttsRateEn ?? ttsRate;
    const zhVoices = ttsVoices.filter((v) => v.lang.toLowerCase().startsWith('zh'));
    const enVoices = ttsVoices.filter((v) => v.lang.toLowerCase().startsWith('en'));

    // Preview plumbing. The preview button click is a real user gesture, so
    // Chrome's autoplay gate is satisfied without a separate prime() call.
    // `activePreview` tracks which row's preview is currently playing so each
    // button shows its own play / stop icon (a single shared `tts.speaking`
    // would flicker the wrong button when the user jumps between rows).
    const previewTts = useSpeechSynthesis();
    const [activePreview, setActivePreview] = useState<'default' | 'zh' | 'en' | null>(null);
    useEffect(() => {
        if (!previewTts.speaking) setActivePreview(null);
    }, [previewTts.speaking]);
    const togglePreview = (kind: 'default' | 'zh' | 'en') => {
        if (activePreview === kind) {
            previewTts.cancel();
            return;
        }
        previewTts.cancel();
        setActivePreview(kind);
        if (kind === 'zh') {
            previewTts.speak(SAMPLE_ZH, {
                voiceURI: settings.ttsVoiceZh || settings.ttsVoice,
                rate: ttsRateZh,
                lang: 'zh-CN',
            });
        } else if (kind === 'en') {
            previewTts.speak(SAMPLE_EN, {
                voiceURI: settings.ttsVoiceEn || settings.ttsVoice,
                rate: ttsRateEn,
                lang: 'en-US',
            });
        } else {
            // Default sample is mixed-language so the user can tell whether
            // their default voice handles both — useful before deciding to
            // configure per-language overrides.
            previewTts.speak(SAMPLE_MIXED, {
                voiceURI: settings.ttsVoice,
                rate: ttsRate,
            });
        }
    };
    const silenceMs = settings.silenceMs ?? SETTINGS_DEFAULTS.silenceMs;
    const skipCode = settings.skipCode ?? SETTINGS_DEFAULTS.skipCode;
    const toolCue = settings.toolCue ?? SETTINGS_DEFAULTS.toolCue;

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
                    <Headphones size={13} />
                    语音模式
                </div>
                <div className="settings-item settings-item-row">
                    <Headphones size={18} className="settings-item-icon" />
                    <span className="settings-item-text">默认音色</span>
                    <select
                        className="settings-select"
                        value={settings.ttsVoice ?? ''}
                        onChange={(e) => updateSettings({ ttsVoice: e.target.value })}
                        disabled={!ttsSupported}
                        aria-label="默认音色"
                    >
                        <option value="">浏览器默认</option>
                        {filteredVoices.map((v) => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                                {v.name}{v.localService ? '' : '（云端）'} · {v.lang}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="settings-preview-btn"
                        onClick={() => togglePreview('default')}
                        disabled={!ttsSupported}
                        aria-label={activePreview === 'default' ? '停止试听' : '试听默认音色'}
                        title={activePreview === 'default' ? '停止试听' : '试听'}
                    >
                        {activePreview === 'default' ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                    </button>
                </div>
                <label className="settings-item settings-item-row">
                    <Headphones size={18} className="settings-item-icon" />
                    <span className="settings-item-text">默认语速</span>
                    <span className="settings-item-value-meta">{ttsRate.toFixed(1)}×</span>
                    <input
                        type="range"
                        className="settings-slider"
                        min={0.5}
                        max={2}
                        step={0.1}
                        value={ttsRate}
                        onChange={(e) => updateSettings({ ttsRate: Number(e.target.value) })}
                        disabled={!ttsSupported}
                        aria-label="默认语速"
                    />
                </label>
                <div className="settings-item settings-item-row">
                    <Headphones size={18} className="settings-item-icon" />
                    <span className="settings-item-text">中文音色</span>
                    <select
                        className="settings-select"
                        value={settings.ttsVoiceZh ?? ''}
                        onChange={(e) => updateSettings({ ttsVoiceZh: e.target.value })}
                        disabled={!ttsSupported}
                        aria-label="中文音色"
                    >
                        <option value="">沿用默认</option>
                        {zhVoices.map((v) => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                                {v.name}{v.localService ? '' : '（云端）'} · {v.lang}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="settings-preview-btn"
                        onClick={() => togglePreview('zh')}
                        disabled={!ttsSupported}
                        aria-label={activePreview === 'zh' ? '停止试听' : '试听中文音色'}
                        title={activePreview === 'zh' ? '停止试听' : '试听'}
                    >
                        {activePreview === 'zh' ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                    </button>
                </div>
                <label className="settings-item settings-item-row">
                    <Headphones size={18} className="settings-item-icon" />
                    <span className="settings-item-text">中文语速</span>
                    <span className="settings-item-value-meta">{ttsRateZh.toFixed(1)}×</span>
                    <input
                        type="range"
                        className="settings-slider"
                        min={0.5}
                        max={2}
                        step={0.1}
                        value={ttsRateZh}
                        onChange={(e) => updateSettings({ ttsRateZh: Number(e.target.value) })}
                        disabled={!ttsSupported}
                        aria-label="中文语速"
                    />
                </label>
                <div className="settings-item settings-item-row">
                    <Headphones size={18} className="settings-item-icon" />
                    <span className="settings-item-text">英文音色</span>
                    <select
                        className="settings-select"
                        value={settings.ttsVoiceEn ?? ''}
                        onChange={(e) => updateSettings({ ttsVoiceEn: e.target.value })}
                        disabled={!ttsSupported}
                        aria-label="英文音色"
                    >
                        <option value="">沿用默认</option>
                        {enVoices.map((v) => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                                {v.name}{v.localService ? '' : '（云端）'} · {v.lang}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="settings-preview-btn"
                        onClick={() => togglePreview('en')}
                        disabled={!ttsSupported}
                        aria-label={activePreview === 'en' ? '停止试听' : '试听英文音色'}
                        title={activePreview === 'en' ? '停止试听' : '试听'}
                    >
                        {activePreview === 'en' ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                    </button>
                </div>
                <label className="settings-item settings-item-row">
                    <Headphones size={18} className="settings-item-icon" />
                    <span className="settings-item-text">英文语速</span>
                    <span className="settings-item-value-meta">{ttsRateEn.toFixed(1)}×</span>
                    <input
                        type="range"
                        className="settings-slider"
                        min={0.5}
                        max={2}
                        step={0.1}
                        value={ttsRateEn}
                        onChange={(e) => updateSettings({ ttsRateEn: Number(e.target.value) })}
                        disabled={!ttsSupported}
                        aria-label="英文语速"
                    />
                </label>
                <label className="settings-item settings-item-row">
                    <Mic size={18} className="settings-item-icon" />
                    <span className="settings-item-text">静默后自动发送</span>
                    <span className="settings-item-value-meta">{(silenceMs / 1000).toFixed(1)}s</span>
                    <input
                        type="range"
                        className="settings-slider"
                        min={500}
                        max={4000}
                        step={250}
                        value={silenceMs}
                        onChange={(e) => updateSettings({ silenceMs: Number(e.target.value) })}
                        disabled={!voiceSupported}
                        aria-label="静默后自动发送时长"
                    />
                </label>
                <label className="settings-item settings-item-row">
                    <Mic size={18} className="settings-item-icon" />
                    <span className="settings-item-text">发送触发词</span>
                    <input
                        type="text"
                        className="settings-text-input"
                        placeholder="可选，如 发送发送"
                        value={settings.sendTrigger ?? ''}
                        onChange={(e) => updateSettings({ sendTrigger: e.target.value })}
                        disabled={!voiceSupported}
                        aria-label="发送触发词"
                        spellCheck={false}
                        maxLength={32}
                    />
                </label>
                <label className="settings-item settings-item-row">
                    <Mic size={18} className="settings-item-icon" />
                    <span className="settings-item-text">中断朗读触发词</span>
                    <input
                        type="text"
                        className="settings-text-input"
                        placeholder="可选，如 别说了"
                        value={settings.stopReadingTrigger ?? ''}
                        onChange={(e) => updateSettings({ stopReadingTrigger: e.target.value })}
                        disabled={!voiceSupported}
                        aria-label="中断朗读触发词"
                        spellCheck={false}
                        maxLength={32}
                    />
                </label>
                <label className="settings-item settings-item-row">
                    <Mic size={18} className="settings-item-icon" />
                    <span className="settings-item-text">中断思考触发词</span>
                    <input
                        type="text"
                        className="settings-text-input"
                        placeholder="可选，如 停止思考"
                        value={settings.abortTrigger ?? ''}
                        onChange={(e) => updateSettings({ abortTrigger: e.target.value })}
                        disabled={!voiceSupported}
                        aria-label="中断思考触发词"
                        spellCheck={false}
                        maxLength={32}
                    />
                </label>
                <label className="settings-item settings-item-row">
                    <Mic size={18} className="settings-item-icon" />
                    <span className="settings-item-text">撤销输入触发词</span>
                    <input
                        type="text"
                        className="settings-text-input"
                        placeholder="可选，如 重来"
                        value={settings.cancelTrigger ?? ''}
                        onChange={(e) => updateSettings({ cancelTrigger: e.target.value })}
                        disabled={!voiceSupported}
                        aria-label="撤销输入触发词"
                        spellCheck={false}
                        maxLength={32}
                    />
                </label>
                <label className="settings-item settings-item-row">
                    <ScrollText size={18} className="settings-item-icon" />
                    <span className="settings-item-text">跳过代码块朗读</span>
                    <input
                        type="checkbox"
                        className="settings-toggle"
                        checked={skipCode}
                        onChange={(e) => updateSettings({ skipCode: e.target.checked })}
                    />
                </label>
                <label className="settings-item settings-item-row">
                    <ScrollText size={18} className="settings-item-icon" />
                    <span className="settings-item-text">工具调用提示音</span>
                    <input
                        type="checkbox"
                        className="settings-toggle"
                        checked={toolCue}
                        onChange={(e) => updateSettings({ toolCue: e.target.checked })}
                    />
                </label>
                {!ttsSupported && (
                    <div className="settings-item-note">
                        当前浏览器不支持 SpeechSynthesis API，无法朗读 agent 回答。
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

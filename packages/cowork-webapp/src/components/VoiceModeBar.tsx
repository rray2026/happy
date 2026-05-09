import type { VoicePhase } from '../hooks/voiceMode';

interface Props {
    phase: VoicePhase;
    suspended: boolean;
}

const PHASE_TEXT: Record<VoicePhase, string> = {
    idle: '',
    listening: '正在听…',
    pending: '等待发送…',
    thinking: '思考中…',
    speaking: '朗读中',
};

/**
 * Thin status banner pinned just under the chat header while voice mode is
 * on. Designed for glance-ability while driving — the dot color and label
 * change is the primary feedback. The actual STT preview lives in the
 * centered VoiceLiveTranscript overlay so it can be much bigger without
 * stealing space from the conversation.
 */
export function VoiceModeBar({ phase, suspended }: Props) {
    if (phase === 'idle' && !suspended) return null;
    const label = suspended ? '已暂停（输入或等待权限）' : PHASE_TEXT[phase];
    const cls = suspended ? 'suspended' : phase;
    return (
        <div className={`voice-bar voice-bar-${cls}`} role="status" aria-live="polite">
            <span className="voice-bar-dot" aria-hidden="true" />
            <span className="voice-bar-label">{label}</span>
        </div>
    );
}

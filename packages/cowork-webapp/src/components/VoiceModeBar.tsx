import type { VoicePhase } from '../hooks/voiceMode';

interface Props {
    phase: VoicePhase;
    suspended: boolean;
    /** Live STT preview to show alongside the status. Empty hides the preview. */
    transcript?: string;
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
 * change is the primary feedback. When the user is actually talking, also
 * surfaces the live transcript so they can verify STT is hearing them.
 */
export function VoiceModeBar({ phase, suspended, transcript }: Props) {
    if (phase === 'idle' && !suspended) return null;
    const label = suspended ? '已暂停（输入或等待权限）' : PHASE_TEXT[phase];
    const cls = suspended ? 'suspended' : phase;
    const showTranscript = !!transcript && (phase === 'listening' || phase === 'pending');
    return (
        <div className={`voice-bar voice-bar-${cls}`} role="status" aria-live="polite">
            <span className="voice-bar-dot" aria-hidden="true" />
            <span className="voice-bar-label">{label}</span>
            {showTranscript && (
                <span className="voice-bar-transcript" title={transcript}>
                    {transcript}
                </span>
            )}
        </div>
    );
}

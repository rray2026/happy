import { Square } from 'lucide-react';

interface Props {
    visible: boolean;
    onStop: () => void;
}

/**
 * Big thumb-reachable "stop reading" affordance that sits low in the chat
 * area while TTS is playing. Driving-scenario-first: the user shouldn't
 * have to look up at the header or hunt for a small icon.
 */
export function VoiceStopButton({ visible, onStop }: Props) {
    if (!visible) return null;
    return (
        <button
            type="button"
            className="voice-stop-btn"
            onClick={onStop}
            aria-label="停止朗读"
        >
            <Square size={16} fill="currentColor" />
            <span>停止朗读</span>
        </button>
    );
}

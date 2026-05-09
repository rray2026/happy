interface Props {
    /** Live STT preview: finalized words + the current interim hypothesis. */
    transcript: string;
    /** Whether to show — caller should pass `false` when the phase isn't
     *  user-speaking ('listening' / 'pending'), so the bubble disappears
     *  during agent thinking and TTS readback. */
    visible: boolean;
    /** Pulse the bubble once the silence timer has armed, signaling that
     *  the message is about to send unless the user retracts it. */
    pending: boolean;
}

/**
 * Big, centered, glance-able overlay of what STT just heard. Pinned to the
 * middle of the chat area so a driver can verify the recognition without
 * looking at any specific corner of the screen. Hides whenever the live
 * transcript is empty so it doesn't loiter as visual noise between turns.
 */
export function VoiceLiveTranscript({ transcript, visible, pending }: Props) {
    if (!visible || !transcript.trim()) return null;
    return (
        <div
            className={`voice-live-transcript${pending ? ' voice-live-transcript-pending' : ''}`}
            role="status"
            aria-live="polite"
        >
            {transcript}
        </div>
    );
}

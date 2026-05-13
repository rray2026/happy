import type { ReactNode } from 'react';

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
    /** `[start, end)` ranges within `transcript` that hit an enabled wake-
     *  word. Highlighted in a distinct color so the user gets visual
     *  confirmation before / as the trigger fires. */
    triggerRanges?: Array<[number, number]>;
    /** Preview-before-send state. When not 'off', the bubble switches from
     *  live STT preview to the captured / polished text awaiting user
     *  confirmation. */
    previewKind?: 'off' | 'polishing' | 'preview';
    previewRaw?: string;
    previewPolished?: string;
    previewError?: string;
}

/** Sort + merge overlapping/adjacent ranges so we can split the transcript
 *  into a clean sequence of plain / highlighted segments. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
    if (ranges.length <= 1) return ranges.slice();
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
    const out: Array<[number, number]> = [sorted[0].slice() as [number, number]];
    for (let i = 1; i < sorted.length; i++) {
        const last = out[out.length - 1];
        const [s, e] = sorted[i];
        if (s <= last[1]) {
            last[1] = Math.max(last[1], e);
        } else {
            out.push([s, e]);
        }
    }
    return out;
}

function renderSegments(text: string, ranges: Array<[number, number]>): ReactNode {
    const merged = mergeRanges(ranges).filter(([s, e]) => s < e && s < text.length);
    if (!merged.length) return text;
    const out: ReactNode[] = [];
    let cursor = 0;
    merged.forEach(([s, e], idx) => {
        const start = Math.max(cursor, s);
        const end = Math.min(text.length, e);
        if (start > cursor) out.push(text.slice(cursor, start));
        if (end > start) {
            out.push(
                <mark key={`m${idx}`} className="voice-live-trigger">
                    {text.slice(start, end)}
                </mark>,
            );
        }
        cursor = Math.max(cursor, end);
    });
    if (cursor < text.length) out.push(text.slice(cursor));
    return out;
}

/**
 * Big, centered, glance-able overlay of what STT just heard. Pinned to the
 * middle of the chat area so a driver can verify the recognition without
 * looking at any specific corner of the screen. Hides whenever the live
 * transcript is empty so it doesn't loiter as visual noise between turns.
 *
 * Two display modes:
 * - Normal live STT: transcript shown with trigger highlight; pulses when
 *   the silence timer is armed.
 * - Preview-before-send: shows raw + polished side-by-side with a hint
 *   line so the user knows to confirm or retract.
 */
export function VoiceLiveTranscript({
    transcript,
    visible,
    pending,
    triggerRanges,
    previewKind = 'off',
    previewRaw = '',
    previewPolished = '',
    previewError,
}: Props) {
    if (!visible && previewKind === 'off') return null;
    if (previewKind === 'off' && !transcript.trim()) return null;

    if (previewKind !== 'off') {
        const polished = previewPolished.trim();
        const raw = previewRaw.trim();
        // Always render both lines so the user can compare before/after at
        // a glance — even when the model returned the input unchanged.
        // What gets sent on confirm is decided in voiceMode.ts
        // (polished || raw), this is purely display.
        const polishedSame = polished && polished === raw;
        const polishedLabel = polishedSame ? '润色：（无变化）' : polished
            ? `润色：${polished}`
            : previewKind === 'polishing'
                ? '润色：处理中…'
                : '润色：—';
        return (
            <div
                className={`voice-live-transcript voice-live-preview${previewKind === 'polishing' ? ' voice-live-preview-polishing' : ''}`}
                role="status"
                aria-live="polite"
            >
                <div className="voice-live-preview-raw">原文：{raw}</div>
                <div className="voice-live-preview-polished">{polishedLabel}</div>
                {previewError ? <div className="voice-live-preview-error">{previewError}</div> : null}
                {previewKind === 'preview' ? (
                    <div className="voice-live-preview-hint">
                        说「发送」确认 · 「重来」取消 · 直接继续说话会追加到原文重新润色
                    </div>
                ) : null}
            </div>
        );
    }

    const content = triggerRanges && triggerRanges.length > 0
        ? renderSegments(transcript, triggerRanges)
        : transcript;
    return (
        <div
            className={`voice-live-transcript${pending ? ' voice-live-transcript-pending' : ''}`}
            role="status"
            aria-live="polite"
        >
            {content}
        </div>
    );
}

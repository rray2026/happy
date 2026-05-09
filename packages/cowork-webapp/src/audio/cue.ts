/**
 * Tiny "tool execution" cue. We synthesize a 120ms 880 Hz sine ping via the
 * Web Audio API instead of bundling an audio file — it stays under a kilobyte
 * of code and the cue isn't pitched to be musical, just clearly distinct
 * from speech.
 *
 * Reuses one AudioContext across calls; some browsers throttle creation.
 * iOS requires the context to be resumed inside a user-gesture chain, so the
 * first cue may swallow silently if it fires from a non-gesture path; from
 * voice-mode that's fine because the user already toggled the mode on with
 * a tap.
 */

let ctxRef: AudioContext | null = null;

function getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (ctxRef) return ctxRef;
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) return null;
    try {
        ctxRef = new Ctor();
        return ctxRef;
    } catch {
        return null;
    }
}

export function playToolCue(): void {
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        // Best-effort; if the browser refuses (no gesture context), we just
        // don't play. Don't await — keep this synchronous.
        ctx.resume().catch(() => undefined);
    }
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        osc.type = 'sine';
        osc.connect(gain);
        gain.connect(ctx.destination);

        const now = ctx.currentTime;
        // Quick attack / decay so it sounds like a "ping", not a tone.
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.18, now + 0.012);
        gain.gain.linearRampToValueAtTime(0, now + 0.13);

        osc.start(now);
        osc.stop(now + 0.14);
    } catch {
        // Best-effort: a missed cue is acceptable.
    }
}

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Imperative wrapper around `window.speechSynthesis`.
 *
 * `speaking` is *our* truth, derived from utterance lifecycle events we
 * attach in `speak()`. We deliberately don't poll `speechSynthesis.speaking`
 * — Chrome occasionally leaves that flag stuck at `true` after `cancel()`,
 * which used to wedge the voice-mode UI in "朗读中" with no audio and no way
 * to recover short of switching the mode off. Trusting our own counter
 * means cancel() can decisively force-clear the local view, regardless of
 * what the engine reports.
 */

interface Options {
    /** Playback rate, 0.5–2.0. Default 1.0. */
    rate?: number;
    /** Voice URI (from speechSynthesis.getVoices()). Default = browser pick. */
    voiceURI?: string;
    /** BCP-47 lang tag, used as a fallback when `voiceURI` doesn't match anything. */
    lang?: string;
    onError?: (msg: string) => void;
}

export interface SpeechSynthesisHandle {
    supported: boolean;
    speaking: boolean;
    speak: (text: string) => void;
    cancel: () => void;
    /**
     * Trigger a silent utterance synchronously inside a user-gesture handler
     * so the browser unlocks audio output for the rest of the page's life.
     * Without this, Chrome silently fails subsequent off-gesture `speak()`
     * calls with `error: not-allowed` (its autoplay policy treats long-delayed
     * TTS as if it weren't user-initiated).
     */
    prime: () => void;
}

export function isSpeechSynthesisSupported(): boolean {
    return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';
}

export function useSpeechSynthesis(opts: Options = {}): SpeechSynthesisHandle {
    const { rate, voiceURI, lang, onError } = opts;
    const [speaking, setSpeaking] = useState(false);
    /** Number of utterances we've handed to the engine that haven't yet
     *  emitted onend / onerror / safety-timed-out. Authoritative source for
     *  the `speaking` boolean. */
    const inFlightRef = useRef(0);
    const onErrorRef = useRef(onError);
    useEffect(() => { onErrorRef.current = onError; }, [onError]);

    const supported = isSpeechSynthesisSupported();

    const speak = useCallback((text: string) => {
        if (!supported || !text.trim()) return;
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate ?? 1;
        if (lang) u.lang = lang;
        if (voiceURI) {
            const v = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
            if (v) u.voice = v;
        }
        // Each utterance settles exactly once, regardless of how the
        // browser fires its events (some emit onend, some onerror with
        // 'canceled', some Safari builds drop both). Safety timeout
        // backstops the rare dropped event so inFlight can't strand.
        let settled = false;
        let safetyTimer: ReturnType<typeof setTimeout> | null = null;
        const settle = () => {
            if (settled) return;
            settled = true;
            if (safetyTimer) {
                clearTimeout(safetyTimer);
                safetyTimer = null;
            }
            inFlightRef.current = Math.max(0, inFlightRef.current - 1);
            setSpeaking(inFlightRef.current > 0);
        };
        u.onend = settle;
        u.onerror = (e: SpeechSynthesisErrorEvent) => {
            settle();
            if (e.error === 'canceled' || e.error === 'interrupted') return;
            onErrorRef.current?.(e.error || 'tts error');
        };
        // Generous backstop: minimum 2 minutes plus 800ms per character to
        // cover the worst case (rate=0.5 + Chinese voice ≈ 480ms/char) with
        // ~2x safety margin. Only fires if the engine truly dropped events —
        // must never preempt a real reading.
        const estMs = Math.max(120_000, text.length * 800);
        safetyTimer = setTimeout(settle, estMs);
        try {
            window.speechSynthesis.speak(u);
            inFlightRef.current += 1;
            setSpeaking(true);
        } catch (err) {
            // Speak() threw before queuing — undo the bookkeeping we did
            // optimistically (none yet) and surface the error.
            settled = true;
            if (safetyTimer) {
                clearTimeout(safetyTimer);
                safetyTimer = null;
            }
            onErrorRef.current?.(err instanceof Error ? err.message : String(err));
        }
    }, [supported, rate, voiceURI, lang]);

    const cancel = useCallback(() => {
        if (!supported) return;
        // Reset *our* truth first. The engine's `cancel()` is best-effort —
        // we deliberately don't condition our local state on whether it
        // actually drained, because it sometimes doesn't.
        inFlightRef.current = 0;
        setSpeaking(false);
        try {
            window.speechSynthesis.cancel();
        } catch {
            // best-effort
        }
    }, [supported]);

    const prime = useCallback(() => {
        if (!supported) return;
        try {
            const u = new SpeechSynthesisUtterance(' ');
            u.volume = 0;
            // Deliberately NOT tracked in inFlightRef — prime is fire-and-
            // forget for the autoplay unlock; counting it would flicker
            // phase to "speaking" the moment voice mode turns on.
            window.speechSynthesis.speak(u);
        } catch {
            // best-effort
        }
    }, [supported]);

    // Lost-event recovery: tts.speaking is event-driven, but a small fraction
    // of browsers (chiefly older Safari) occasionally drop both onend and
    // onerror — we'd then sit on inFlight > 0 until the safety timeout
    // (minutes). To recover fast without re-introducing the cancel-stickiness
    // bug from polled state, this loop NEVER pulls speaking back to true; it
    // can only decrement when the engine has been demonstrably idle for
    // multiple consecutive checks while we still think a turn is in flight.
    useEffect(() => {
        if (!supported) return;
        let idleStreak = 0;
        const iv = setInterval(() => {
            if (inFlightRef.current === 0) { idleStreak = 0; return; }
            const engineLive =
                window.speechSynthesis.speaking || window.speechSynthesis.pending;
            if (engineLive) { idleStreak = 0; return; }
            idleStreak += 1;
            if (idleStreak >= 3) {
                // Engine has been idle for ~3 ticks (~1.5s) while we thought
                // it was busy. Browser dropped an event — force-settle one
                // utterance. If more were dropped, the loop fires again next
                // tick until inFlight drains.
                inFlightRef.current = Math.max(0, inFlightRef.current - 1);
                setSpeaking(inFlightRef.current > 0);
                idleStreak = 0;
            }
        }, 500);
        return () => clearInterval(iv);
    }, [supported]);

    // Hard stop on unmount so a navigation doesn't leave the page chattering.
    useEffect(() => () => {
        if (!supported) return;
        inFlightRef.current = 0;
        try { window.speechSynthesis.cancel(); } catch { /* noop */ }
    }, [supported]);

    return { supported, speaking, speak, cancel, prime };
}

/**
 * Live list of available SpeechSynthesisVoices. The browser populates this
 * asynchronously (some via voiceschanged event), so a one-shot getVoices()
 * at mount can come back empty.
 */
export function useTtsVoices(): SpeechSynthesisVoice[] {
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() =>
        isSpeechSynthesisSupported() ? window.speechSynthesis.getVoices() : [],
    );
    useEffect(() => {
        if (!isSpeechSynthesisSupported()) return;
        const update = () => setVoices(window.speechSynthesis.getVoices());
        update();
        window.speechSynthesis.addEventListener('voiceschanged', update);
        return () => window.speechSynthesis.removeEventListener('voiceschanged', update);
    }, []);
    return voices;
}

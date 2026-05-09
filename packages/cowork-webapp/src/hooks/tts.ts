import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Imperative wrapper around `window.speechSynthesis`. We don't try to be
 * fancy — the browser already serializes utterances internally; we just
 * push, listen for `end`, and surface a `speaking` flag that polls instead
 * of trusting `onstart` / `onend` (Safari sometimes drops them).
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
     * Trigger an empty utterance synchronously inside a user-gesture handler
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
        u.onerror = (e: SpeechSynthesisErrorEvent) => {
            if (e.error === 'canceled' || e.error === 'interrupted') return;
            onErrorRef.current?.(e.error || 'tts error');
        };
        try {
            window.speechSynthesis.speak(u);
        } catch (err) {
            onErrorRef.current?.(err instanceof Error ? err.message : String(err));
        }
    }, [supported, rate, voiceURI, lang]);

    const cancel = useCallback(() => {
        if (!supported) return;
        window.speechSynthesis.cancel();
        setSpeaking(false);
    }, [supported]);

    /** Synchronously emit a silent utterance to satisfy Chrome's audio
     *  autoplay gate. Must be called from inside a user-gesture handler
     *  (e.g. the click that toggles voice mode on). */
    const prime = useCallback(() => {
        if (!supported) return;
        try {
            const u = new SpeechSynthesisUtterance(' ');
            u.volume = 0;
            window.speechSynthesis.speak(u);
        } catch {
            // best-effort
        }
    }, [supported]);

    // `speechSynthesis.speaking` is the truth — poll it. The native onend /
    // onstart fire inconsistently across browsers and per-utterance, but we
    // only care whether *any* utterance is currently being synthesized.
    useEffect(() => {
        if (!supported) return;
        const iv = setInterval(() => {
            const isSpeaking = window.speechSynthesis.speaking || window.speechSynthesis.pending;
            setSpeaking((prev) => (prev !== isSpeaking ? isSpeaking : prev));
        }, 200);
        return () => clearInterval(iv);
    }, [supported]);

    // Hard stop on unmount so a navigation doesn't leave the page chattering.
    useEffect(() => () => {
        if (supported) window.speechSynthesis.cancel();
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

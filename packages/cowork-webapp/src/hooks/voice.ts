import { useCallback, useEffect, useRef, useState } from 'react';

// The Web Speech API is unprefixed in the spec but most browsers still ship
// only the `webkit*` name (Chrome/Edge/Safari). Firefox doesn't implement it
// at all — `supported` reads false there. We declare just enough of the
// surface to build against without pulling in @types for it.

interface SpeechRecognitionEventLike {
    resultIndex: number;
    results: ArrayLike<{
        0: { transcript: string };
        isFinal: boolean;
    }>;
}

interface SpeechRecognitionErrorEventLike {
    error: string;
    message?: string;
}

interface SpeechRecognitionInstance {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((e: SpeechRecognitionEventLike) => void) | null;
    onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionInstance) | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as {
        SpeechRecognition?: new () => SpeechRecognitionInstance;
        webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Cheap feature-detection probe — safe to call from anywhere, including
 * outside React. Avoids paying the cost of instantiating useSpeechRecognition
 * just to check whether a UI surface should render.
 */
export function isSpeechRecognitionSupported(): boolean {
    return getSpeechRecognitionCtor() !== null;
}

interface Options {
    /** BCP-47 language tag (e.g. 'zh-CN', 'en-US'). Defaults to navigator.language. */
    lang?: string;
    /**
     * Called for each result chunk. `final` is true when the engine has locked
     * in the words; false means it's still revising the last few. Callers
     * usually want to accumulate finals into the visible value and render the
     * latest interim as a transient suffix.
     */
    onTranscript: (text: string, final: boolean) => void;
    /** Optional error sink. Default: silent (caller decides UX). */
    onError?: (message: string) => void;
}

export interface SpeechRecognitionHandle {
    /** True when the underlying API is available. Falsy on Firefox / no-mic env. */
    supported: boolean;
    listening: boolean;
    start: () => void;
    stop: () => void;
}

/**
 * Imperative wrapper around Web Speech API for "press to dictate" flows.
 * Handles feature detection, lifecycle (single instance per hook), and
 * auto-stop when the component unmounts.
 */
export function useSpeechRecognition(opts: Options): SpeechRecognitionHandle {
    const { lang, onTranscript, onError } = opts;
    const [listening, setListening] = useState(false);
    const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
    // Snapshot the latest callbacks so the imperative recognition object,
    // which we keep across renders, always sees the current implementation
    // without rebuilding the recognition instance on every render.
    const onTranscriptRef = useRef(onTranscript);
    const onErrorRef = useRef(onError);
    useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
    useEffect(() => { onErrorRef.current = onError; }, [onError]);

    const Ctor = getSpeechRecognitionCtor();
    const supported = !!Ctor;

    const start = useCallback(() => {
        if (!Ctor || recognitionRef.current) return;
        const r = new Ctor();
        r.lang = lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
        r.continuous = true;
        r.interimResults = true;
        r.onresult = (e) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const result = e.results[i];
                onTranscriptRef.current(result[0].transcript, result.isFinal);
            }
        };
        r.onerror = (e) => {
            // 'no-speech' / 'aborted' fire on idle/cancel paths and aren't
            // user-actionable — surface only the rest.
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            onErrorRef.current?.(e.message || e.error);
        };
        r.onend = () => {
            recognitionRef.current = null;
            setListening(false);
        };
        recognitionRef.current = r;
        try {
            r.start();
            setListening(true);
        } catch (err) {
            recognitionRef.current = null;
            onErrorRef.current?.(err instanceof Error ? err.message : String(err));
        }
    }, [Ctor, lang]);

    const stop = useCallback(() => {
        recognitionRef.current?.stop();
    }, []);

    useEffect(() => {
        return () => {
            recognitionRef.current?.abort();
            recognitionRef.current = null;
        };
    }, []);

    return { supported, listening, start, stop };
}

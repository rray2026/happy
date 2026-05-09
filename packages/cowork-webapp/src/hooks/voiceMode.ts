import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionClient } from '../session';
import type { Item } from '../types';
import { useSpeechRecognition } from './voice';
import { useSpeechSynthesis } from './tts';
import { playToolCue } from '../audio/cue';

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceModeOptions {
    sessionId: string;
    items: Item[];
    isBusy: boolean;
    /** True when the user is currently typing — voice loop should stand down. */
    hasInput: boolean;
    /** True when a permission modal is on screen — voice loop must wait for click. */
    hasPermission: boolean;
    voiceLang?: string;
    ttsVoice?: string;
    ttsRate?: number;
    /** Extra silence after browser onend before we send (default 2500ms). */
    silenceMs?: number;
    /** Strip code blocks from TTS output. */
    skipCode?: boolean;
    /** Play a "ping" cue when a tool call appears in the stream. */
    toolCue?: boolean;
    onError?: (msg: string) => void;
}

export interface VoiceModeHandle {
    /** True when the user has switched voice mode on for this session. */
    active: boolean;
    /** Live phase. `idle` includes "off" and "suspended"; check `suspended` to disambiguate. */
    phase: VoicePhase;
    /** True while active but blocked (typing / permission modal). */
    suspended: boolean;
    /** True when the underlying APIs (STT + TTS) are both available. */
    supported: boolean;
    setActive: (next: boolean) => void;
    toggle: () => void;
    /** Cancel current TTS and any pending sentences; voice loop returns to listening. */
    stopReading: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const STRONG_TERMINATORS = ['.', '!', '?', '。', '！', '？', '；', ';'];
const WEAK_TERMINATORS = [',', '，', '、', '\n'];

/**
 * Strip markdown / fenced code / inline code so the TTS engine doesn't read
 * out punctuation salad. If a code fence is open at the end, drop everything
 * from the opening — we don't want to start reading code prose mid-block.
 */
function cleanForSpeech(text: string, skipCode: boolean): string {
    let out = text;
    if (skipCode) {
        // Closed fenced blocks: strip entirely (replace with one space so
        // sentences on either side don't fuse).
        out = out.replace(/```[\s\S]*?```/g, ' ');
        // Open fence at the tail: drop from there.
        const openIdx = out.lastIndexOf('```');
        if (openIdx >= 0) out = out.slice(0, openIdx);
        // Inline code → space (keeps natural pause).
        out = out.replace(/`[^`\n]+`/g, ' ');
    }
    // Markdown noise
    out = out
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
        .replace(/^>\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/`/g, '')
        .replace(/[ \t]+/g, ' ');
    return out;
}

/** First chunk-end position after `start`, or -1 if we should wait for more text. */
function findChunkEnd(text: string, start: number, fallbackAfter = 60): number {
    let lastStrong = -1;
    for (let i = start; i < text.length; i++) {
        if (STRONG_TERMINATORS.includes(text[i])) {
            const next = text[i + 1];
            if (next === undefined || next === ' ' || next === '\n' || next === '\t') {
                lastStrong = i + 1;
            }
        }
    }
    if (lastStrong > start) return lastStrong;

    // First-sentence fallback: speak something at the next natural break
    // once the buffer is long enough so the user doesn't sit in silence.
    if (text.length - start >= fallbackAfter) {
        let lastWeak = -1;
        for (let i = start; i < text.length; i++) {
            if (WEAK_TERMINATORS.includes(text[i])) lastWeak = i + 1;
        }
        if (lastWeak > start) return lastWeak;
    }
    return -1;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useVoiceMode(opts: VoiceModeOptions): VoiceModeHandle {
    const {
        sessionId,
        items,
        isBusy,
        hasInput,
        hasPermission,
        voiceLang,
        ttsVoice,
        ttsRate,
        silenceMs = 2500,
        skipCode = true,
        toolCue = true,
        onError,
    } = opts;

    const [active, setActive] = useState(false);
    /** Bridge the gap between sendInput and the server reflecting busy=true,
     *  during which the local recognition would otherwise still be listening
     *  and might capture the tail of our own utterance or the start of TTS. */
    const [pendingSend, setPendingSend] = useState(false);
    const suspended = active && (hasInput || hasPermission);

    // ── TTS plumbing ────────────────────────────────────────────────────────
    const tts = useSpeechSynthesis({
        rate: ttsRate,
        voiceURI: ttsVoice,
        lang: voiceLang,
        onError,
    });
    /** FIFO of pending sentences. We pump one at a time so cancel() is clean.
     *  `queueLen` is the same length as a React state so phase derivation
     *  during render stays in sync without reading a ref. */
    const ttsQueueRef = useRef<string[]>([]);
    const [queueLen, setQueueLen] = useState(0);
    const enqueueTts = useCallback((text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        ttsQueueRef.current.push(trimmed);
        setQueueLen(ttsQueueRef.current.length);
    }, []);

    // Drain pump: whenever the queue has work and TTS is idle, kick off the
    // next utterance. Suspended / inactive paths drain the queue instead.
    useEffect(() => {
        if (!active || suspended) return;
        if (tts.speaking) return;
        const next = ttsQueueRef.current.shift();
        if (next) {
            tts.speak(next);
            setQueueLen(ttsQueueRef.current.length);
        }
    }, [queueLen, tts.speaking, active, suspended, tts]);

    // ── Item-stream → sentence chunker ──────────────────────────────────────
    /** Per-item read pointer in the *cleaned* text coordinate space. */
    const readEndsRef = useRef<Map<string, number>>(new Map());
    /** Tool-item ids we've already played a cue for, so streaming + replay don't double-ping. */
    const cuedToolIdsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!active || suspended) return;
        for (const item of items) {
            if (item.kind === 'tools') {
                if (toolCue && !cuedToolIdsRef.current.has(item.id)) {
                    cuedToolIdsRef.current.add(item.id);
                    playToolCue();
                }
                continue;
            }
            if (item.kind !== 'assistant') continue;
            const cleaned = cleanForSpeech(item.text, skipCode);
            const start = readEndsRef.current.get(item.id) ?? 0;
            // If streaming hasn't yet flipped past prior `start`, nothing new.
            if (cleaned.length <= start) continue;
            // If the assistant message is finalized, flush whatever's left
            // even without a sentence terminator at the very end.
            const isFinal = item.streaming === false || item.streaming === undefined;
            const end = findChunkEnd(cleaned, start);
            if (end > start) {
                enqueueTts(cleaned.slice(start, end));
                readEndsRef.current.set(item.id, end);
            } else if (isFinal && cleaned.length > start) {
                enqueueTts(cleaned.slice(start));
                readEndsRef.current.set(item.id, cleaned.length);
            }
        }
    }, [items, active, suspended, skipCode, toolCue, enqueueTts]);

    // Reset read pointers when the session changes — different items, can't
    // carry over. Also reset the cue dedup set.
    useEffect(() => {
        readEndsRef.current = new Map();
        cuedToolIdsRef.current = new Set();
    }, [sessionId]);

    // ── STT plumbing (silence-buffered auto-send) ───────────────────────────
    const transcriptRef = useRef('');
    const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelSilenceTimer = useCallback(() => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
    }, []);

    const stt = useSpeechRecognition({
        lang: voiceLang,
        onTranscript: (text, final) => {
            if (!final) return;
            transcriptRef.current = (transcriptRef.current + ' ' + text).trim();
            // Reset silence timer on every final chunk.
            cancelSilenceTimer();
            silenceTimerRef.current = setTimeout(() => {
                silenceTimerRef.current = null;
                const pending = transcriptRef.current.trim();
                transcriptRef.current = '';
                if (pending && active && !suspended) {
                    sessionClient.sendInput(sessionId, pending);
                    sessionClient.appendOptimisticUser(sessionId, pending);
                    setPendingSend(true);
                }
            }, silenceMs);
        },
        onError,
    });

    // pendingSend bridges the time between our sendInput call and the agent
    // reflecting busy=true. Clear it once the server actually flips busy, or
    // after a 5s failsafe so a dropped echo doesn't lock us out of listening.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        if (!pendingSend) return;
        if (isBusy) { setPendingSend(false); return; }
        const t = setTimeout(() => setPendingSend(false), 5000);
        return () => clearTimeout(t);
    }, [pendingSend, isBusy]);
    /* eslint-enable react-hooks/set-state-in-effect */

    // Listening lifecycle. The recognition API self-stops after silence; we
    // re-arm it whenever we should be listening but aren't.
    useEffect(() => {
        if (!active || suspended) {
            cancelSilenceTimer();
            transcriptRef.current = '';
            if (stt.listening) stt.stop();
            return;
        }
        // Don't listen while the agent is replying or while we're reading
        // its response; otherwise we'll hear our own TTS.
        const shouldListen =
            !isBusy && !pendingSend && !tts.speaking && queueLen === 0;
        if (shouldListen && !stt.listening) stt.start();
        if (!shouldListen && stt.listening) stt.stop();
    }, [active, suspended, isBusy, pendingSend, tts.speaking, queueLen, stt, cancelSilenceTimer]);

    // ── Suspended / inactive cleanup ────────────────────────────────────────
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        if (active && !suspended) return;
        // Drop any pending speech and silence the engine.
        ttsQueueRef.current = [];
        setQueueLen(0);
        if (tts.speaking) tts.cancel();
        cancelSilenceTimer();
        transcriptRef.current = '';
    }, [active, suspended, tts, cancelSilenceTimer]);

    // ── Session change / unmount: turn off entirely. ────────────────────────
    useEffect(() => {
        // Reset the toggle whenever the user navigates to a different chat.
        setActive(false);
    }, [sessionId]);
    /* eslint-enable react-hooks/set-state-in-effect */
    useEffect(() => () => {
        ttsQueueRef.current = [];
        if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
    }, []);

    // ── Public controls ─────────────────────────────────────────────────────
    const toggle = useCallback(() => setActive((a) => !a), []);
    const stopReading = useCallback(() => {
        ttsQueueRef.current = [];
        setQueueLen(0);
        tts.cancel();
        // Mark current assistant items as fully read so the next stream chunk
        // continues from there, instead of re-speaking what we just stopped.
        for (const item of items) {
            if (item.kind === 'assistant') {
                const cleaned = cleanForSpeech(item.text, skipCode);
                readEndsRef.current.set(item.id, cleaned.length);
            }
        }
    }, [tts, items, skipCode]);

    // ── Phase derivation ────────────────────────────────────────────────────
    let phase: VoicePhase;
    if (!active || suspended) phase = 'idle';
    else if (tts.speaking || queueLen > 0) phase = 'speaking';
    else if (isBusy) phase = 'thinking';
    else phase = 'listening';

    return {
        active,
        phase,
        suspended,
        supported: stt.supported && tts.supported,
        setActive,
        toggle,
        stopReading,
    };
}

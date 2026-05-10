import { useSyncExternalStore } from 'react';

/**
 * Lightweight key/value settings store backed by a single `cowork:settings`
 * localStorage entry. Subscribers re-render via useSyncExternalStore the
 * moment any setting changes — same pattern as nameStore, just generic.
 *
 * Keep keys flat and primitive-typed; if a setting needs structure, give it
 * its own dedicated store.
 */
const KEY = 'cowork:settings';

export interface Settings {
    /** BCP-47 language tag for SpeechRecognition. Empty means "use navigator.language". */
    voiceLang?: string;
    /** SpeechSynthesisVoice.voiceURI to use for TTS. Empty = browser default.
     *  Acts as the fallback when a per-language override (ttsVoiceZh /
     *  ttsVoiceEn) isn't set. */
    ttsVoice?: string;
    /** TTS rate, 0.5–2.0. Defaults to 1.0 when unset. Acts as the fallback
     *  when a per-language override (ttsRateZh / ttsRateEn) isn't set. */
    ttsRate?: number;
    /** Override voice for Chinese segments. Falls back to ttsVoice. */
    ttsVoiceZh?: string;
    /** Override rate for Chinese segments (0.5–2.0). Falls back to ttsRate. */
    ttsRateZh?: number;
    /** Override voice for English segments. Falls back to ttsVoice. */
    ttsVoiceEn?: string;
    /** Override rate for English segments (0.5–2.0). Falls back to ttsRate. */
    ttsRateEn?: number;
    /** Voice-mode auto-send silence buffer in ms (after browser onend). Default 2500. */
    silenceMs?: number;
    /** Wake word that, when said at the end of an utterance, sends immediately
     *  without waiting for the silence buffer. Empty = disabled.
     *  Matched after stripping whitespace and punctuation, case-insensitively. */
    sendTrigger?: string;
    /** Wake word that, when said anywhere in an utterance, cancels the current
     *  TTS readback (drains the queue, stops the engine). The transcript is
     *  discarded. Empty = disabled. Same normalization rules as sendTrigger. */
    stopReadingTrigger?: string;
    /** Wake word that, when said anywhere in an utterance, aborts the agent's
     *  in-flight turn (RPC session.abort). The transcript is discarded.
     *  Empty = disabled. Same normalization rules as sendTrigger. */
    abortTrigger?: string;
    /** Wake word to retract the currently-captured input: drops the buffered
     *  transcript and the silence countdown so the user can re-say their
     *  message without it ever leaving the device. Empty = disabled.
     *  Same normalization rules as sendTrigger. */
    cancelTrigger?: string;
    /** Wrapper text added to every voice-mode send before it reaches the
     *  agent. Use `{message}` to mark where the user's spoken text should
     *  be inserted; if the placeholder is absent, the template is prepended
     *  with a blank line. Empty = no wrapping. Useful for nudging the
     *  agent towards short, voice-friendly replies in driving scenarios
     *  ("请用 2-3 句话回复，不要代码块"). */
    voicePromptTemplate?: string;
    /** Skip fenced + inline code blocks during TTS. Default true. */
    skipCode?: boolean;
    /** Play a short audio cue when the agent invokes a tool (instead of reading it). Default true. */
    toolCue?: boolean;
}

export const SETTINGS_DEFAULTS = {
    ttsRate: 1.0,
    silenceMs: 2500,
    skipCode: true,
    toolCue: true,
} as const;

let cache: Settings | null = null;
const listeners = new Set<() => void>();

function read(): Settings {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Settings;
    } catch {
        return {};
    }
}

export function loadSettings(): Settings {
    if (cache === null) cache = read();
    return cache;
}

export function updateSettings(patch: Partial<Settings>): void {
    const next: Settings = { ...loadSettings(), ...patch };
    // Drop empty-string optional fields so the persisted JSON stays compact.
    for (const k of Object.keys(next) as (keyof Settings)[]) {
        const v = next[k];
        if (v === '' || v === undefined || v === null) delete next[k];
    }
    cache = next;
    try {
        localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // localStorage quota etc. — in-memory cache still propagates below.
    }
    listeners.forEach((l) => l());
}

export function subscribeSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useSettings(): Settings {
    return useSyncExternalStore(subscribeSettings, loadSettings, loadSettings);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pinyin } from 'pinyin-pro';
import { sessionClient, uid } from '../session';
import type { Item } from '../types';
import { useSpeechRecognition } from './voice';
import { useSpeechSynthesis } from './tts';
import { playToolCue } from '../audio/cue';

export type VoicePhase = 'idle' | 'listening' | 'pending' | 'thinking' | 'speaking';
/** Voice mode variant. `full` = STT + TTS (hands-free); `input` = STT only,
 *  agent replies render visually but aren't read aloud. */
export type VoiceModeKind = 'full' | 'input';

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
    /** Optional wake-word: when an utterance ends with this phrase, send
     *  immediately without waiting for the silence buffer. Matched after
     *  normalizing whitespace/punctuation. Empty = disabled. */
    sendTrigger?: string;
    /** Optional wake-word that, when heard anywhere in an utterance, cancels
     *  the current TTS readback (drains the queue + stops the engine). The
     *  transcript itself is discarded. Empty = disabled. */
    stopReadingTrigger?: string;
    /** Optional wake-word that, when heard anywhere in an utterance, aborts
     *  the agent's in-flight turn (RPC session.abort). The transcript itself
     *  is discarded. Empty = disabled. */
    abortTrigger?: string;
    /** Optional wake-word that retracts the currently-captured speech: drops
     *  the buffer and the silence countdown so the user can start the
     *  utterance over. Empty = disabled. */
    cancelTrigger?: string;
    /** Strip code blocks from TTS output. */
    skipCode?: boolean;
    /** Play a "ping" cue when a tool call appears in the stream. */
    toolCue?: boolean;
    onError?: (msg: string) => void;
}

export interface VoiceModeHandle {
    /** True when the user has switched voice mode on for this session. */
    active: boolean;
    /** Selected variant; meaningful only when `active`. */
    mode: VoiceModeKind;
    /** Live phase. `idle` includes "off" and "suspended"; check `suspended` to disambiguate. */
    phase: VoicePhase;
    /** True while active but blocked (typing / permission modal). */
    suspended: boolean;
    /** True when the underlying APIs are available. STT alone is required for
     *  `input` mode; TTS is additionally required for `full` mode. */
    supported: boolean;
    /** True when TTS is also available — gates the `full` mode button in the UI. */
    ttsSupported: boolean;
    /** Live transcription preview: finalised words plus the current interim
     *  hypothesis. Cleared on send / stop / cancel. Empty when not listening. */
    liveTranscript: string;
    /** `[start, end)` code-unit ranges within `liveTranscript` that match an
     *  enabled trigger word (send / stop-reading / abort / cancel). Only
     *  exact pinyin matches are listed — fuzzy hits don't have a precise
     *  source range and pass through un-highlighted. */
    liveTriggerRanges: Array<[number, number]>;
    setActive: (next: boolean) => void;
    /** UI tap: switch to `kind` (turning on if off), or turn off if already
     *  active in that kind. Marks current items as read and primes TTS as
     *  needed; callers must invoke this synchronously inside a click handler
     *  so Chrome's autoplay gate sees a user gesture. */
    toggleMode: (kind: VoiceModeKind) => void;
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

/**
 * Strip whitespace and punctuation, lowercase, then run pinyin in array mode
 * over the whole stripped string. The array mode is what lets polyphones
 * resolve in context — `了` in "别说了" → "le", but `pinyin('了')` alone
 * defaults to "liao". If we converted char by char we'd get a different form
 * for the trigger and the transcript and the match would silently miss.
 *
 * Each entry corresponds to one source character of the stripped string, so
 * concatenating gives the canonical normalized form and matchers that need
 * char-boundary alignment can iterate the array directly.
 *
 * Non-Chinese characters (latin letters, digits) pass through unchanged as
 * single-char entries.
 */
function pinyinArrayOf(s: string): string[] {
    const stripped = s.toLowerCase().replace(/[\s\p{P}]+/gu, '');
    if (!stripped) return [];
    return pinyin(stripped, { toneType: 'none', type: 'array' }).map((p) => p.toLowerCase());
}

/**
 * Canonical pinyin form: ws/punct stripped, lowercased, Chinese → toneless
 * pinyin. So homophone misrecognitions still match — "停止" / "停滞" / "庭制"
 * all normalize to "tingzhi" — which is the whole point: Web Speech is shaky
 * on Chinese tones and similar-sound chars, and we don't want a wake-word to
 * silently miss because the engine guessed the wrong character.
 */
export function normalizeForTrigger(s: string): string {
    return pinyinArrayOf(s).join('');
}

// ── Weighted phonetic distance ──────────────────────────────────────────────
//
// Catalogue of common pinyin substring confusables — both Chinese regional
// accent patterns and Web Speech mishearings collapse onto these pairs. Each
// entry is (a, b, cost): substituting a↔b costs `cost` instead of the default
// 1.0. The table is small on purpose — we want misheard wake-words to match,
// not arbitrary near-rhymes.
const PINYIN_CONFUSABLES: ReadonlyArray<readonly [string, string, number]> = [
    // 平翘舌不分: zh/z, ch/c, sh/s
    ['zh', 'z', 0.2],
    ['ch', 'c', 0.2],
    ['sh', 's', 0.2],
    // 前后鼻音不分: ing/in, eng/en, ang/an
    ['ing', 'in', 0.2],
    ['eng', 'en', 0.2],
    ['ang', 'an', 0.2],
    // 边鼻音 n/l
    ['n', 'l', 0.3],
    // h/f (湖北/福建一带)
    ['h', 'f', 0.3],
    // r/l
    ['r', 'l', 0.3],
];

/**
 * Weighted Levenshtein on pinyin strings. Single-char substitutions cost
 * 1 if different, 0 if same; multi-char "macro" substitutions from
 * PINYIN_CONFUSABLES cost less. Insertions and deletions cost 1.
 *
 * Exposed for tests.
 */
export function pinyinPhoneticDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const subCost = a[i - 1] === b[j - 1] ? 0 : 1;
            let best = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + subCost,
            );
            for (const [x, y, c] of PINYIN_CONFUSABLES) {
                if (i >= x.length && j >= y.length &&
                    a.endsWith(x, i) && b.endsWith(y, j)) {
                    best = Math.min(best, dp[i - x.length][j - y.length] + c);
                }
                if (i >= y.length && j >= x.length &&
                    a.endsWith(y, i) && b.endsWith(x, j)) {
                    best = Math.min(best, dp[i - y.length][j - x.length] + c);
                }
            }
            dp[i][j] = best;
        }
    }
    return dp[m][n];
}

/**
 * For each non-overlapping char-boundary-aligned occurrence of `triggerNorm`
 * in `transcript` (pinyin canonical form), return the `[start, end)`
 * code-unit range of the original transcript covered by the match. Only does
 * exact match — fuzzy-matched triggers don't have a precise source range and
 * just go un-highlighted. Used to paint the trigger word a different color
 * inside the live preview.
 */
export function findTriggerRangesInOriginal(
    transcript: string,
    triggerNorm: string,
): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    if (!triggerNorm || !transcript) return ranges;

    let stripped = '';
    const origStart: number[] = [];
    const origEnd: number[] = [];
    let pos = 0;
    for (const c of transcript) {
        const cuLen = c.length;
        if (!/[\s\p{P}]/u.test(c)) {
            stripped += c.toLowerCase();
            origStart.push(pos);
            origEnd.push(pos + cuLen);
        }
        pos += cuLen;
    }
    if (!stripped) return ranges;
    const chars = pinyin(stripped, { toneType: 'none', type: 'array' }).map((p) => p.toLowerCase());
    if (chars.length !== origStart.length) return ranges; // defensive

    let i = 0;
    while (i < chars.length) {
        let acc = '';
        let matchedTo = -1;
        for (let j = i; j < chars.length; j++) {
            acc += chars[j];
            if (acc === triggerNorm) {
                matchedTo = j;
                break;
            }
            if (acc.length > triggerNorm.length) break;
        }
        if (matchedTo >= 0) {
            ranges.push([origStart[i], origEnd[matchedTo]]);
            i = matchedTo + 1;
        } else {
            i++;
        }
    }
    return ranges;
}

/** Min normalized-pinyin length at which fuzzy matching kicks in. Below this
 *  (≈ 1 Chinese char), the false-positive rate from edit-distance slack
 *  starts to swallow legitimate non-trigger speech. */
const FUZZY_MIN_LEN = 6;
/** Per-char allowed cost for fuzzy match. 0.2 means a 10-char trigger tolerates
 *  up to 2.0 cost — i.e. ~2 confusable substitutions, or one full-cost edit. */
const FUZZY_COST_RATIO = 0.2;
/** Window-size slack: how many chars longer/shorter than the trigger can
 *  still be considered for fuzzy match. Keeps the search bounded. */
const FUZZY_LEN_SLACK = 2;

/**
 * Char-boundary-aligned `includes`: true iff some contiguous run of source
 * characters in `transcript` normalizes to `triggerNorm` either exactly, or
 * within phonetic edit distance for triggers long enough to make a fuzzy
 * match meaningful. Prevents accidents like trigger "ing" matching the tail
 * of "停" (pinyin "ting") — exact match is char-boundary aligned and the
 * fuzzy fallback is gated on minimum length.
 */
export function triggerOccursIn(transcript: string, triggerNorm: string): boolean {
    if (!triggerNorm) return false;
    const chars = pinyinArrayOf(transcript);

    // Exact, char-boundary aligned.
    for (let i = 0; i < chars.length; i++) {
        let acc = '';
        for (let j = i; j < chars.length; j++) {
            acc += chars[j];
            if (acc === triggerNorm) return true;
            if (acc.length > triggerNorm.length) break;
        }
    }

    // Fuzzy fallback: weighted edit distance over each candidate window
    // aligned at char boundaries. Skipped for short triggers because the
    // false-positive rate dominates there.
    if (triggerNorm.length < FUZZY_MIN_LEN) return false;
    const threshold = triggerNorm.length * FUZZY_COST_RATIO;
    for (let i = 0; i < chars.length; i++) {
        let acc = '';
        for (let j = i; j < chars.length; j++) {
            acc += chars[j];
            if (acc.length > triggerNorm.length + FUZZY_LEN_SLACK) break;
            if (acc.length >= triggerNorm.length - FUZZY_LEN_SLACK) {
                if (pinyinPhoneticDistance(acc, triggerNorm) <= threshold) return true;
            }
        }
    }
    return false;
}

/**
 * If `transcript` ends with `trigger` on a char boundary (after pinyin
 * normalization), return the transcript with the trigger portion removed.
 * Otherwise return null.
 *
 * Walks per-char pinyin from the tail, accumulating until the suffix equals
 * the normalized trigger. Bailing on length-overshoot enforces char-boundary
 * alignment, so a short trigger like "zhi" can't false-match the tail of a
 * single longer-pinyin char. The boundary index is mapped back to the
 * original-string position via origIdx so we can slice the user's actual
 * pre-trigger message out cleanly.
 */
export function stripTrailingTrigger(transcript: string, trigger: string): string | null {
    const triggerNorm = normalizeForTrigger(trigger);
    if (!triggerNorm) return null;

    let stripped = '';
    const origIdx: number[] = [];
    for (let i = 0; i < transcript.length; i++) {
        const c = transcript[i];
        if (!/[\s\p{P}]/u.test(c)) {
            stripped += c.toLowerCase();
            origIdx.push(i);
        }
    }
    if (!stripped) return null;
    const chars = pinyin(stripped, { toneType: 'none', type: 'array' }).map((p) => p.toLowerCase());

    // Exact, char-boundary aligned.
    let suffix = '';
    for (let k = chars.length - 1; k >= 0; k--) {
        suffix = chars[k] + suffix;
        if (suffix === triggerNorm) {
            const cutAt = origIdx[k];
            return transcript.slice(0, cutAt).replace(/[\s\p{P}]+$/u, '').trim();
        }
        if (suffix.length > triggerNorm.length) break;
    }

    // Fuzzy fallback: walk back at char boundaries, find the boundary with
    // smallest phonetic edit distance to the trigger, accept if within
    // threshold. Same min-length gate as triggerOccursIn — short triggers
    // would false-fire too often.
    if (triggerNorm.length < FUZZY_MIN_LEN) return null;
    const threshold = triggerNorm.length * FUZZY_COST_RATIO;
    let bestK = -1;
    let bestCost = Infinity;
    suffix = '';
    for (let k = chars.length - 1; k >= 0; k--) {
        suffix = chars[k] + suffix;
        if (suffix.length > triggerNorm.length + FUZZY_LEN_SLACK) break;
        if (suffix.length >= triggerNorm.length - FUZZY_LEN_SLACK) {
            const cost = pinyinPhoneticDistance(suffix, triggerNorm);
            if (cost <= threshold && cost < bestCost) {
                bestCost = cost;
                bestK = k;
            }
        }
    }
    if (bestK >= 0) {
        const cutAt = origIdx[bestK];
        return transcript.slice(0, cutAt).replace(/[\s\p{P}]+$/u, '').trim();
    }
    return null;
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
        sendTrigger,
        stopReadingTrigger,
        abortTrigger,
        cancelTrigger,
        skipCode = true,
        toolCue = true,
        onError,
    } = opts;

    const [active, setActive] = useState(false);
    const [mode, setMode] = useState<VoiceModeKind>('full');
    /** Bridge the gap between sendInput and the server reflecting busy=true,
     *  during which the local recognition would otherwise still be listening
     *  and might capture the tail of our own utterance or the start of TTS. */
    const [pendingSend, setPendingSend] = useState(false);
    /** True while a silence timer is armed — we have a captured transcript
     *  and are waiting `silenceMs` of quiet before auto-sending. UI shows
     *  this as its own phase ("等待发送…") so the user knows their utterance
     *  was heard and is about to leave. */
    const [silenceCountdown, setSilenceCountdown] = useState(false);
    /** Live preview shown in the status bar so the user can see whether STT
     *  is hearing them right (drivers may glance, desktop users use it to
     *  catch misrecognitions before the silence timer fires). Includes
     *  finalised text plus the current interim hypothesis. */
    const [liveTranscript, setLiveTranscript] = useState('');
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

    // Drain pump: dump the entire queue into the browser's TTS engine in one
    // pass. The engine handles serial playback internally, so back-to-back
    // speak() calls are fine. We depend on `speak` (a stable useCallback)
    // rather than the whole `tts` object so the pump doesn't re-run on
    // every parent render just because tts.speaking changed.
    const ttsSpeak = tts.speak;
    useEffect(() => {
        if (!active || suspended || mode !== 'full') return;
        if (ttsQueueRef.current.length === 0) return;
        let pumped = false;
        while (ttsQueueRef.current.length > 0) {
            const next = ttsQueueRef.current.shift()!;
            ttsSpeak(next);
            pumped = true;
        }
        if (pumped) setQueueLen(0);
    }, [queueLen, active, suspended, mode, ttsSpeak]);

    // ── Item-stream → sentence chunker ──────────────────────────────────────
    /** Per-item read pointer in the *cleaned* text coordinate space. */
    const readEndsRef = useRef<Map<string, number>>(new Map());
    /** Tool-item ids we've already played a cue for, so streaming + replay don't double-ping. */
    const cuedToolIdsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!active || suspended || mode !== 'full') return;
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
            // Treat the chunk as final when:
            // - streaming flag explicitly says so, OR
            // - the item is not from a streaming source (undefined), OR
            // - the agent itself reports idle (some backends never emit a
            //   `_final` marker; trust the busy signal as a backstop).
            const isFinal = item.streaming === false || item.streaming === undefined || !isBusy;
            const end = findChunkEnd(cleaned, start);
            if (end > start) {
                enqueueTts(cleaned.slice(start, end));
                readEndsRef.current.set(item.id, end);
            } else if (isFinal && cleaned.length > start) {
                enqueueTts(cleaned.slice(start));
                readEndsRef.current.set(item.id, cleaned.length);
            }
        }
    }, [items, active, suspended, mode, skipCode, toolCue, enqueueTts, isBusy]);

    // Stale-stream backstop: if items haven't changed for ~1.5s and we still
    // have unread assistant text, flush it. This catches agents that fall
    // silent without ever clearing the streaming flag or busy state.
    useEffect(() => {
        if (!active || suspended || mode !== 'full') return;
        const t = setTimeout(() => {
            for (const item of items) {
                if (item.kind !== 'assistant') continue;
                const cleaned = cleanForSpeech(item.text, skipCode);
                const start = readEndsRef.current.get(item.id) ?? 0;
                if (cleaned.length > start) {
                    enqueueTts(cleaned.slice(start));
                    readEndsRef.current.set(item.id, cleaned.length);
                }
            }
        }, 1500);
        return () => clearTimeout(t);
    }, [items, active, suspended, mode, skipCode, enqueueTts]);

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
        setSilenceCountdown(false);
    }, []);

    const stt = useSpeechRecognition({
        lang: voiceLang,
        onTranscript: (text, final) => {
            if (!final) {
                // Interim hypothesis — show finalised text so far + this
                // tentative chunk so the user can see it forming.
                const merged = (transcriptRef.current + ' ' + text).trim();
                if (merged) setLiveTranscript(merged);
                return;
            }
            transcriptRef.current = (transcriptRef.current + ' ' + text).trim();
            setLiveTranscript(transcriptRef.current);

            // Interrupt wake-words: matched anywhere (not just tail) on a
            // char boundary. stopReadingTrigger only makes sense when there's
            // TTS to stop, so it's gated on `mode === 'full'`. abortTrigger
            // works in both modes (input mode can still abort a thinking
            // agent). Both bail before the sendTrigger check so a phrase like
            // "停止 发送" can't accidentally send.
            const stopReadingNorm =
                mode === 'full' && stopReadingTrigger ? normalizeForTrigger(stopReadingTrigger) : '';
            const abortNorm = abortTrigger ? normalizeForTrigger(abortTrigger) : '';
            const matchedStop = !!stopReadingNorm && triggerOccursIn(transcriptRef.current, stopReadingNorm);
            const matchedAbort = !!abortNorm && triggerOccursIn(transcriptRef.current, abortNorm);
            if (matchedStop || matchedAbort) {
                cancelSilenceTimer();
                transcriptRef.current = '';
                setLiveTranscript('');
                if (active && !suspended) {
                    if (matchedStop) {
                        ttsQueueRef.current = [];
                        setQueueLen(0);
                        tts.cancel();
                    }
                    if (matchedAbort && isBusy) {
                        sessionClient.rpc(uid(), 'session.abort', { sessionId }).catch(() => undefined);
                    }
                }
                return;
            }

            // Barge-in window: while the agent is replying or TTS is reading
            // back, STT stays alive (so triggers can fire), but non-trigger
            // captures don't get queued for sending — stacking another turn
            // on top of the in-flight one isn't what the user wants. We keep
            // accumulating into transcriptRef so that a multi-chunk trigger
            // ("别"+"说"+"了") can still match across STT events; the
            // falling-edge effect below scrubs the buffer once the window
            // closes if no trigger ever fired.
            if (isBusy || tts.speaking || queueLen > 0) return;

            // Cancel wake-word: retracts the current capture and the silence
            // countdown so the user can re-say their message. Only checked
            // outside the barge-in window — during agent thinking / TTS the
            // accumulated buffer isn't headed anywhere user-visible anyway.
            if (cancelTrigger) {
                const cancelNorm = normalizeForTrigger(cancelTrigger);
                if (cancelNorm && triggerOccursIn(transcriptRef.current, cancelNorm)) {
                    cancelSilenceTimer();
                    transcriptRef.current = '';
                    setLiveTranscript('');
                    return;
                }
            }

            // Wake-word fast-path: if the user said the configured trigger
            // at the tail of the utterance, send immediately and skip the
            // silence wait.
            if (sendTrigger) {
                const stripped = stripTrailingTrigger(transcriptRef.current, sendTrigger);
                if (stripped !== null) {
                    cancelSilenceTimer();
                    transcriptRef.current = '';
                    setLiveTranscript('');
                    if (stripped && active && !suspended) {
                        sessionClient.sendInput(sessionId, stripped);
                        sessionClient.appendOptimisticUser(sessionId, stripped);
                        setPendingSend(true);
                    }
                    return;
                }
            }

            // Reset silence timer on every final chunk.
            cancelSilenceTimer();
            silenceTimerRef.current = setTimeout(() => {
                silenceTimerRef.current = null;
                setSilenceCountdown(false);
                const pending = transcriptRef.current.trim();
                transcriptRef.current = '';
                setLiveTranscript('');
                if (pending && active && !suspended) {
                    sessionClient.sendInput(sessionId, pending);
                    sessionClient.appendOptimisticUser(sessionId, pending);
                    setPendingSend(true);
                }
            }, silenceMs);
            setSilenceCountdown(true);
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
    // re-arm it whenever we should be listening but aren't. We deliberately
    // keep STT alive during isBusy and TTS readback so the user can interrupt
    // via wake-word — non-trigger captures during that window are dropped in
    // onTranscript, and the falling-edge effect scrubs the buffer when the
    // window closes. The only true pause is `pendingSend` (brief gap between
    // sendInput and isBusy reflecting), where mic echo of the just-sent
    // utterance would otherwise feed back as a new transcript.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        if (!active || suspended) {
            cancelSilenceTimer();
            transcriptRef.current = '';
            setLiveTranscript('');
            if (stt.listening) stt.stop();
            return;
        }
        const shouldListen = !pendingSend;
        if (shouldListen && !stt.listening) stt.start();
        if (!shouldListen && stt.listening) stt.stop();
    }, [active, suspended, pendingSend, stt, cancelSilenceTimer]);
    /* eslint-enable react-hooks/set-state-in-effect */

    // Falling-edge of the barge-in window: once the agent stops thinking and
    // TTS finishes, drop anything we accumulated during it. That speech was
    // either a trigger (already handled) or non-trigger noise we agreed to
    // discard — keeping it would let stale fragments combine with the next
    // utterance into a spurious silence-timer send.
    const prevBargeinRef = useRef(false);
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        const bargein = isBusy || tts.speaking || queueLen > 0;
        if (prevBargeinRef.current && !bargein) {
            transcriptRef.current = '';
            setLiveTranscript('');
            cancelSilenceTimer();
        }
        prevBargeinRef.current = bargein;
    }, [isBusy, tts.speaking, queueLen, cancelSilenceTimer]);
    /* eslint-enable react-hooks/set-state-in-effect */

    // ── Suspended / inactive / non-full-mode cleanup ───────────────────────
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        // Drain TTS whenever readback shouldn't be running: voice off, suspended,
        // or active in input-only mode. STT cleanup only fires when we're truly
        // off or suspended — input mode keeps listening.
        if (mode !== 'full' || !active || suspended) {
            ttsQueueRef.current = [];
            setQueueLen(0);
            if (tts.speaking) tts.cancel();
        }
        if (!active || suspended) {
            cancelSilenceTimer();
            transcriptRef.current = '';
            setLiveTranscript('');
        }
    }, [active, suspended, mode, tts, cancelSilenceTimer]);

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
    const toggleMode = useCallback((kind: VoiceModeKind) => {
        if (active && mode === kind) {
            setActive(false);
            return;
        }
        if (active) {
            // Cross-mode switch is disallowed: user must turn off first, then
            // pick the other mode. Forcing transitions through the off state
            // makes the audio lifecycle (TTS prime, queue drain) deterministic
            // and the UI's "which mode am I in" easy to reason about.
            return;
        }
        // Entering from off. Mark every existing assistant item as fully read
        // and every tool call as already cued — otherwise the chunker would
        // replay the entire visible history when TTS turns on.
        for (const item of items) {
            if (item.kind === 'assistant') {
                const cleaned = cleanForSpeech(item.text, skipCode);
                readEndsRef.current.set(item.id, cleaned.length);
            } else if (item.kind === 'tools') {
                cuedToolIdsRef.current.add(item.id);
            }
        }
        if (kind === 'full') {
            // Prime audio synchronously inside the click handler so Chrome's
            // autoplay gate doesn't reject the first off-gesture speak() N
            // seconds later when the agent finally replies.
            tts.prime();
        }
        setMode(kind);
        setActive(true);
    }, [active, mode, items, skipCode, tts]);
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

    // ── Live-transcript trigger-word highlight ──────────────────────────────
    // Scan the current preview for any configured trigger and report the
    // matched original-string ranges so the overlay can paint them in a
    // different color. Recomputes only when the live text or a trigger
    // setting changes — cheap (each match is one DP-free scan over per-char
    // pinyin). stopReadingTrigger is excluded in input mode where it's
    // ignored anyway.
    const liveTriggerRanges = useMemo<Array<[number, number]>>(() => {
        if (!liveTranscript) return [];
        const triggers: string[] = [];
        if (sendTrigger) triggers.push(sendTrigger);
        if (mode === 'full' && stopReadingTrigger) triggers.push(stopReadingTrigger);
        if (abortTrigger) triggers.push(abortTrigger);
        if (cancelTrigger) triggers.push(cancelTrigger);
        const out: Array<[number, number]> = [];
        for (const t of triggers) {
            const tn = normalizeForTrigger(t);
            if (!tn) continue;
            out.push(...findTriggerRangesInOriginal(liveTranscript, tn));
        }
        return out;
    }, [liveTranscript, mode, sendTrigger, stopReadingTrigger, abortTrigger, cancelTrigger]);

    // ── Phase derivation ────────────────────────────────────────────────────
    // `tts.speaking` is our authoritative "an utterance is in flight"
    // signal — flipped true synchronously inside speak() and force-cleared
    // by cancel(), so no polling lag and no engine-state stickiness.
    let phase: VoicePhase;
    if (!active || suspended) phase = 'idle';
    else if (tts.speaking || queueLen > 0) phase = 'speaking';
    else if (isBusy || pendingSend) phase = 'thinking';
    else if (silenceCountdown) phase = 'pending';
    else phase = 'listening';

    return {
        active,
        mode,
        phase,
        suspended,
        // STT alone is enough for `input` mode; the UI uses `ttsSupported`
        // to additionally gate the `full` mode button.
        supported: stt.supported,
        ttsSupported: tts.supported,
        liveTranscript,
        liveTriggerRanges,
        setActive,
        toggleMode,
        stopReading,
    };
}

import { describe, expect, it } from 'vitest';
import {
    normalizeForTrigger,
    stripTrailingTrigger,
    triggerOccursIn,
} from './voiceMode';

describe('normalizeForTrigger', () => {
    it('lowercases ASCII and strips whitespace + punctuation', () => {
        expect(normalizeForTrigger('Hello, World!')).toBe('helloworld');
    });

    it('converts Chinese to toneless pinyin without separators', () => {
        expect(normalizeForTrigger('停止')).toBe('tingzhi');
    });

    it('collapses homophones to the same pinyin form', () => {
        const a = normalizeForTrigger('停止');
        const b = normalizeForTrigger('停滞');
        const c = normalizeForTrigger('庭制');
        expect(a).toBe('tingzhi');
        expect(b).toBe(a);
        expect(c).toBe(a);
    });

    it('handles mixed Chinese / latin / digits', () => {
        expect(normalizeForTrigger('Hi 你好 123')).toBe('hinihao123');
    });

    it('strips both ASCII and CJK punctuation', () => {
        expect(normalizeForTrigger('停止！，.;')).toBe('tingzhi');
    });

    it('returns empty for whitespace-only input', () => {
        expect(normalizeForTrigger('   ')).toBe('');
        expect(normalizeForTrigger('！？。')).toBe('');
    });
});

describe('triggerOccursIn (char-boundary aligned anywhere-includes)', () => {
    it('matches a trigger that appears mid-utterance', () => {
        expect(triggerOccursIn('我想停止现在', normalizeForTrigger('停止'))).toBe(true);
    });

    it('matches across pinyin homophones', () => {
        // user said 停滞, trigger configured as 停止 — both → "tingzhi"
        expect(triggerOccursIn('我想停滞一下', normalizeForTrigger('停止'))).toBe(true);
    });

    it('refuses sub-syllable matches that fall inside a single char (char-boundary protection)', () => {
        // Trigger "ing" should NOT match the tail of 停 (pinyin "ting") — that
        // would be the kind of false positive char-boundary alignment exists
        // to prevent.
        expect(triggerOccursIn('我说停', normalizeForTrigger('ing'))).toBe(false);
    });

    it('returns false when the trigger never appears', () => {
        expect(triggerOccursIn('完全没有相关的话', normalizeForTrigger('停止'))).toBe(false);
    });

    it('returns false on empty trigger', () => {
        expect(triggerOccursIn('any text', '')).toBe(false);
    });

    it('matches a trigger spanning whitespace / punctuation between source chars', () => {
        // 别 说 了 with spaces and punctuation between — normalization strips both.
        expect(triggerOccursIn('别, 说 了。', normalizeForTrigger('别说了'))).toBe(true);
    });
});

describe('stripTrailingTrigger', () => {
    it('strips an exact trailing trigger', () => {
        expect(stripTrailingTrigger('你好停止', '停止')).toBe('你好');
    });

    it('strips through homophones', () => {
        // user said 停滞 at the tail, configured trigger is 停止
        expect(stripTrailingTrigger('帮我看一下停滞', '停止')).toBe('帮我看一下');
    });

    it('strips through trailing punctuation/whitespace', () => {
        expect(stripTrailingTrigger('你好 停止！', '停止')).toBe('你好');
    });

    it('returns null when the trigger is not at the tail', () => {
        // Trigger appears mid-string, not at end — endsWith semantic.
        expect(stripTrailingTrigger('停止之后呢', '停止')).toBeNull();
    });

    it('refuses sub-syllable matches (char-boundary)', () => {
        // Same protection as triggerOccursIn — "ing" must align with a char.
        expect(stripTrailingTrigger('我说停', 'ing')).toBeNull();
    });

    it('returns empty string when the entire utterance is the trigger', () => {
        // Whole transcript is just the wake-word — strip leaves "".
        expect(stripTrailingTrigger('停止', '停止')).toBe('');
    });

    it('returns null for empty trigger', () => {
        expect(stripTrailingTrigger('hello', '')).toBeNull();
    });

    it('handles multi-char latin triggers', () => {
        expect(stripTrailingTrigger('please send', 'send')).toBe('please');
    });

    it('returns null when transcript is shorter than trigger', () => {
        expect(stripTrailingTrigger('停', '停止')).toBeNull();
    });
});

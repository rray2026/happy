import { describe, expect, it } from 'vitest';
import {
    findTriggerRangesInOriginal,
    normalizeForTrigger,
    pinyinPhoneticDistance,
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

describe('pinyinPhoneticDistance', () => {
    it('is 0 for identical strings', () => {
        expect(pinyinPhoneticDistance('tingzhi', 'tingzhi')).toBe(0);
    });

    it('charges the full unit cost for unrelated single-char subs', () => {
        expect(pinyinPhoneticDistance('tingzhi', 'qingzhi')).toBe(1);
    });

    it('charges the discount cost for 平翘舌 confusion (zh↔z)', () => {
        // tingzhi → tingzi: zh→z macro. Cost 0.2.
        expect(pinyinPhoneticDistance('tingzhi', 'tingzi')).toBeCloseTo(0.2, 5);
    });

    it('charges the discount cost for 前后鼻音 confusion (ing↔in)', () => {
        // tingzhi → tinzhi: ing→in macro at position 4. Cost 0.2.
        expect(pinyinPhoneticDistance('tingzhi', 'tinzhi')).toBeCloseTo(0.2, 5);
    });

    it('combines multiple confusables into a sum of discount costs', () => {
        // tingzhi → tinzi: ing→in (0.2) + zh→z (0.2). Total 0.4.
        expect(pinyinPhoneticDistance('tingzhi', 'tinzi')).toBeCloseTo(0.4, 5);
    });

    it('charges 0.3 for n↔l confusion', () => {
        expect(pinyinPhoneticDistance('na', 'la')).toBeCloseTo(0.3, 5);
    });
});

describe('triggerOccursIn — fuzzy fallback', () => {
    it('matches a near-mishearing for triggers ≥ FUZZY_MIN_LEN', () => {
        // Trigger 停止 (tingzhi), user said "停制" pinyin tingzhi → exact.
        // Try a real mis-recognition: tingzi (zh→z) — should still match.
        const trig = normalizeForTrigger('停止');
        // simulate the transcript carrying "tingzi" as a homophone via a char
        // pair that pinyin to "tingzi": 停子 → tingzi.
        expect(triggerOccursIn('请你停子', trig)).toBe(true);
    });

    it('does not fuzzy-match short triggers (under min length)', () => {
        // Trigger "止" (zhi, 3 chars), too short for fuzzy. A near-rhyme like
        // "知" (zhi) matches exactly anyway, but "之" (zhi) too — nothing to
        // test for fuzzy gating here. Instead try trigger "你" (ni) and a
        // transcript with "li" — under fuzzy this would match (n↔l = 0.3,
        // length 2, threshold 0.4); we want it NOT to match because length < 6.
        const trig = normalizeForTrigger('你');
        expect(triggerOccursIn('哩', trig)).toBe(false);
    });

    it('rejects far-distance candidates even for long triggers', () => {
        // Trigger 停止思考 (tingzhisikao). Transcript with completely unrelated
        // pinyin run shouldn't pass the threshold.
        const trig = normalizeForTrigger('停止思考');
        expect(triggerOccursIn('完全无关的话', trig)).toBe(false);
    });
});

describe('findTriggerRangesInOriginal', () => {
    it('reports the original range of a trigger word at the tail', () => {
        const trig = normalizeForTrigger('停止');
        // "请你停止" — 停止 at indices 2..3 (chars), code-units 2..4.
        expect(findTriggerRangesInOriginal('请你停止', trig)).toEqual([[2, 4]]);
    });

    it('reports each occurrence when the trigger appears multiple times', () => {
        const trig = normalizeForTrigger('停止');
        expect(findTriggerRangesInOriginal('停止再停止吧', trig)).toEqual([[0, 2], [3, 5]]);
    });

    it('skips whitespace and punctuation between matched chars', () => {
        const trig = normalizeForTrigger('停止');
        // "停, 止" — punctuation/whitespace between the two source chars.
        // Matches as one range covering "停" through "止" inclusive.
        expect(findTriggerRangesInOriginal('停, 止', trig)).toEqual([[0, 4]]);
    });

    it('reports nothing for transcripts without the trigger', () => {
        const trig = normalizeForTrigger('停止');
        expect(findTriggerRangesInOriginal('完全无关的话', trig)).toEqual([]);
    });

    it('returns empty for empty inputs', () => {
        expect(findTriggerRangesInOriginal('', 'tingzhi')).toEqual([]);
        expect(findTriggerRangesInOriginal('hello', '')).toEqual([]);
    });

    it('aligns at char boundaries (no false sub-syllable matches)', () => {
        // "ing" pinyin tail of 听 (ting) should NOT be reported — same
        // protection as triggerOccursIn.
        expect(findTriggerRangesInOriginal('听', 'ing')).toEqual([]);
    });
});

describe('stripTrailingTrigger — fuzzy fallback', () => {
    it('strips a near-mishearing tail when the trigger is long enough', () => {
        // Trigger 发送发送 (fasongfasong, 12 chars). Tail mis-heard as
        // 发送花送 (fasonghuasong) — h↔f at position 8 costs 0.3, total well
        // below threshold 12*0.2=2.4.
        const result = stripTrailingTrigger('请帮我做这件事 发送花送', '发送发送');
        expect(result).toBe('请帮我做这件事');
    });

    it('returns null when fuzzy distance exceeds threshold', () => {
        // 发送发送 vs random tail "完全不同" — pinyin "wanquanbutong",
        // no overlap with "fasongfasong". Distance >> threshold.
        expect(stripTrailingTrigger('请你完全不同', '发送发送')).toBeNull();
    });

    it('does not fuzzy-strip when trigger is below min length', () => {
        // Trigger "嗯" (3 chars), short enough that fuzzy is gated off.
        // A near-rhyme tail wouldn't match.
        expect(stripTrailingTrigger('哎', '嗯')).toBeNull();
    });
});

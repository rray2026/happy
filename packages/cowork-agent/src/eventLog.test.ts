import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, loadEvents, removeEventLog } from './eventLog.js';

const SID = '11111111-2222-3333-4444-555555555555';

describe('eventLog', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cowork-eventlog-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('returns [] when no log file exists', () => {
        expect(loadEvents(dir, SID)).toEqual([]);
    });

    it('round-trips appended events in original order', () => {
        appendEvent(dir, SID, 0, { type: 'user', text: 'hi' });
        appendEvent(dir, SID, 1, { type: 'assistant', text: 'hello' });
        appendEvent(dir, SID, 2, { type: 'user', text: 'bye' });
        const events = loadEvents(dir, SID);
        expect(events).toEqual([
            { seq: 0, payload: { type: 'user', text: 'hi' } },
            { seq: 1, payload: { type: 'assistant', text: 'hello' } },
            { seq: 2, payload: { type: 'user', text: 'bye' } },
        ]);
    });

    it('persists across multiple writers (one append at a time)', () => {
        for (let i = 0; i < 50; i++) appendEvent(dir, SID, i, i);
        const events = loadEvents(dir, SID);
        expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    });

    it('skips a torn last line (simulated crash mid-write) instead of throwing', () => {
        appendEvent(dir, SID, 0, 'a');
        appendEvent(dir, SID, 1, 'b');
        // Manually corrupt the file by chopping the last line in half.
        const path = join(dir, `${SID}.events.jsonl`);
        const raw = readFileSync(path, 'utf8');
        const truncated = raw.slice(0, -3); // chop final 3 chars: corrupts last line
        writeFileSync(path, truncated, 'utf8');
        // Now append another good event so the truncated line is in the middle.
        appendEvent(dir, SID, 2, 'c');
        const events = loadEvents(dir, SID);
        // Skips the broken middle line, but keeps 'a' and 'c'.
        const seqs = events.map((e) => e.seq);
        expect(seqs).toContain(0);
        expect(seqs).toContain(2);
    });

    it('skips malformed lines without throwing', () => {
        const path = join(dir, `${SID}.events.jsonl`);
        writeFileSync(
            path,
            [
                '{"seq":0,"payload":"good"}',
                'this is not json',
                '{"seq":"not a number","payload":"bad"}',
                '{"seq":1,"payload":"good2"}',
                '',
            ].join('\n'),
            'utf8',
        );
        const events = loadEvents(dir, SID);
        expect(events).toEqual([
            { seq: 0, payload: 'good' },
            { seq: 1, payload: 'good2' },
        ]);
    });

    it('removeEventLog deletes the file', () => {
        appendEvent(dir, SID, 0, 'a');
        expect(loadEvents(dir, SID).length).toBe(1);
        removeEventLog(dir, SID);
        expect(loadEvents(dir, SID)).toEqual([]);
    });

    it('removeEventLog is idempotent (no throw when file is absent)', () => {
        expect(() => removeEventLog(dir, SID)).not.toThrow();
    });

    it('appendEvent creates the directory if missing', () => {
        rmSync(dir, { recursive: true, force: true });
        appendEvent(dir, SID, 0, 'a');
        expect(loadEvents(dir, SID)).toEqual([{ seq: 0, payload: 'a' }]);
    });
});

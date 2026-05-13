import { describe, expect, it } from 'vitest';
import { SessionStore } from './sessionStore.js';

describe('SessionStore', () => {
    describe('empty store', () => {
        it('getCurrentSeq returns -1', () => {
            expect(new SessionStore().getCurrentSeq()).toBe(-1);
        });
        it('getOldestSeq returns -1', () => {
            expect(new SessionStore().getOldestSeq()).toBe(-1);
        });
        it('getDelta returns []', () => {
            expect(new SessionStore().getDelta(-1)).toEqual([]);
        });
    });

    describe('append', () => {
        it('assigns seq starting at 0', () => {
            expect(new SessionStore().append('a')).toBe(0);
        });
        it('increments seq on each append', () => {
            const s = new SessionStore();
            expect(s.append('a')).toBe(0);
            expect(s.append('b')).toBe(1);
            expect(s.append('c')).toBe(2);
        });
        it('stores arbitrary payload types', () => {
            const s = new SessionStore();
            const payload = { type: 'assistant', text: 'hi' };
            s.append(payload);
            expect(s.getDelta(-1)[0]?.payload).toEqual(payload);
        });
    });

    describe('getDelta', () => {
        it('returns all when fromSeq=-1', () => {
            const s = new SessionStore();
            s.append('a');
            s.append('b');
            s.append('c');
            expect(s.getDelta(-1).map((e) => e.seq)).toEqual([0, 1, 2]);
        });
        it('returns only entries strictly > fromSeq', () => {
            const s = new SessionStore();
            s.append('a');
            s.append('b');
            s.append('c');
            expect(s.getDelta(0).map((e) => e.seq)).toEqual([1, 2]);
        });
        it('returns [] when fromSeq >= current', () => {
            const s = new SessionStore();
            s.append('a');
            expect(s.getDelta(0)).toEqual([]);
            expect(s.getDelta(5)).toEqual([]);
        });
    });

    describe('eviction', () => {
        it('evicts oldest once maxSize is exceeded', () => {
            const s = new SessionStore(3);
            s.append('a');
            s.append('b');
            s.append('c');
            s.append('d');
            expect(s.getOldestSeq()).toBe(1);
            expect(s.getDelta(-1)).toHaveLength(3);
        });
        it('getCurrentSeq keeps incrementing past maxSize', () => {
            const s = new SessionStore(3);
            for (let i = 0; i < 10; i++) s.append(i);
            expect(s.getCurrentSeq()).toBe(9);
        });
        it('buffer never grows beyond maxSize', () => {
            const s = new SessionStore(5);
            for (let i = 0; i < 20; i++) s.append(i);
            expect(s.getDelta(-1)).toHaveLength(5);
        });
        it('defaults to 200', () => {
            const s = new SessionStore();
            for (let i = 0; i < 201; i++) s.append(i);
            expect(s.getDelta(-1)).toHaveLength(200);
            expect(s.getOldestSeq()).toBe(1);
        });
    });

    describe('alignTo (agent-restart bridge)', () => {
        it('advances nextSeq so the next append emits at clientSeq+1 when the store is fresh', () => {
            const s = new SessionStore();
            // Fresh store after a process restart, client claims it last saw seq 8.
            s.alignTo(8);
            const next = s.append('hi');
            expect(next).toBe(9);
            expect(s.getCurrentSeq()).toBe(9);
        });

        it('is a no-op when the store already has its own events (regardless of direction)', () => {
            const s = new SessionStore();
            s.append('first'); // nextSeq = 1, no longer initial
            s.alignTo(99); // client claims to be ahead; we trust our own state
            expect(s.append('second')).toBe(1);

            const t = new SessionStore();
            for (let i = 0; i < 5; i++) t.append(i); // nextSeq = 5
            t.alignTo(2); // client behind; ignore
            expect(t.append('x')).toBe(5);
        });

        it('ignores negative clientSeq (no events seen yet)', () => {
            const s = new SessionStore();
            s.alignTo(-1);
            expect(s.append('a')).toBe(0);
        });
    });

    describe('bulkRestore', () => {
        it('restores events with their original seqs', () => {
            const s = new SessionStore();
            s.bulkRestore([
                { seq: 0, payload: 'a' },
                { seq: 1, payload: 'b' },
                { seq: 2, payload: 'c' },
            ]);
            expect(s.getOldestSeq()).toBe(0);
            expect(s.getCurrentSeq()).toBe(2);
        });

        it('advances nextSeq past the highest restored seq', () => {
            const s = new SessionStore();
            s.bulkRestore([
                { seq: 0, payload: 'a' },
                { seq: 1, payload: 'b' },
            ]);
            expect(s.append('next')).toBe(2);
        });

        it('lifts the cap so the full restored history stays resident', () => {
            // maxSize 3 is normally tight; bulkRestore with 6 events lifts the
            // cap to 6 so a low `lastSeq` reconnect can still replay everything.
            const s = new SessionStore(3);
            const events = [0, 1, 2, 3, 4, 5].map((i) => ({ seq: i, payload: `e${i}` }));
            s.bulkRestore(events);
            expect(s.getOldestSeq()).toBe(0);
            expect(s.getCurrentSeq()).toBe(5);
            expect(s.getDelta(-1).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
        });

        it('keeps the lifted cap effective for subsequent appends', () => {
            const s = new SessionStore(3);
            const events = [0, 1, 2, 3, 4].map((i) => ({ seq: i, payload: i }));
            s.bulkRestore(events);
            // Cap should now be 5. One more append → 6 entries, only THEN
            // trimming kicks in.
            s.append('new');
            expect(s.getOldestSeq()).toBe(1);
            expect(s.getCurrentSeq()).toBe(5);
        });

        it('is a no-op when the store already has events', () => {
            const s = new SessionStore();
            s.append('mine'); // nextSeq = 1
            s.bulkRestore([
                { seq: 0, payload: 'restored' },
                { seq: 1, payload: 'also' },
            ]);
            // Should not have replaced or extended our own entries.
            expect(s.getCurrentSeq()).toBe(0);
            expect(s.getDelta(-1).map((e) => e.payload)).toEqual(['mine']);
        });

        it('is a no-op on an empty input', () => {
            const s = new SessionStore();
            s.bulkRestore([]);
            expect(s.getCurrentSeq()).toBe(-1);
            expect(s.append('a')).toBe(0);
        });
    });
});

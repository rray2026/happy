import { describe, expect, it } from 'vitest';
import { SessionStore } from './sessionStore';

describe('SessionStore', () => {

    describe('empty store', () => {
        it('getCurrentSeq returns -1 when empty', () => {
            const store = new SessionStore();
            expect(store.getCurrentSeq()).toBe(-1);
        });

        it('getOldestSeq returns -1 when empty', () => {
            const store = new SessionStore();
            expect(store.getOldestSeq()).toBe(-1);
        });

        it('getDelta returns empty array when empty', () => {
            const store = new SessionStore();
            expect(store.getDelta(-1)).toEqual([]);
        });
    });

    describe('append', () => {
        it('assigns seq starting at 0', () => {
            const store = new SessionStore();
            expect(store.append('a')).toBe(0);
        });

        it('increments seq on each append', () => {
            const store = new SessionStore();
            expect(store.append('a')).toBe(0);
            expect(store.append('b')).toBe(1);
            expect(store.append('c')).toBe(2);
        });

        it('getCurrentSeq reflects the last assigned seq', () => {
            const store = new SessionStore();
            store.append('a');
            store.append('b');
            expect(store.getCurrentSeq()).toBe(1);
        });

        it('getOldestSeq returns 0 after first append', () => {
            const store = new SessionStore();
            store.append('x');
            expect(store.getOldestSeq()).toBe(0);
        });

        it('stores arbitrary payload types', () => {
            const store = new SessionStore();
            const payload = { type: 'assistant', text: 'hello' };
            store.append(payload);
            const delta = store.getDelta(-1);
            expect(delta[0]?.payload).toEqual(payload);
        });
    });

    describe('getDelta', () => {
        it('returns all entries when fromSeq is -1', () => {
            const store = new SessionStore();
            store.append('a');
            store.append('b');
            store.append('c');
            const delta = store.getDelta(-1);
            expect(delta).toHaveLength(3);
            expect(delta.map(e => e.seq)).toEqual([0, 1, 2]);
        });

        it('returns only entries with seq strictly greater than fromSeq', () => {
            const store = new SessionStore();
            store.append('a'); // seq 0
            store.append('b'); // seq 1
            store.append('c'); // seq 2
            const delta = store.getDelta(0);
            expect(delta).toHaveLength(2);
            expect(delta.map(e => e.seq)).toEqual([1, 2]);
        });

        it('returns empty array when fromSeq equals getCurrentSeq', () => {
            const store = new SessionStore();
            store.append('a'); // seq 0
            expect(store.getDelta(0)).toEqual([]);
        });

        it('returns empty array when fromSeq exceeds all stored seqs', () => {
            const store = new SessionStore();
            store.append('a'); // seq 0
            expect(store.getDelta(5)).toEqual([]);
        });

        it('payload is preserved correctly in delta entries', () => {
            const store = new SessionStore();
            store.append('first');
            store.append('second');
            store.append('third');
            const delta = store.getDelta(0);
            expect(delta[0]?.payload).toBe('second');
            expect(delta[1]?.payload).toBe('third');
        });
    });

    describe('circular buffer eviction', () => {
        it('evicts the oldest entry when maxSize is exceeded', () => {
            const store = new SessionStore(3);
            store.append('a'); // seq 0
            store.append('b'); // seq 1
            store.append('c'); // seq 2
            store.append('d'); // seq 3 — evicts seq 0

            expect(store.getOldestSeq()).toBe(1);
            expect(store.getDelta(-1)).toHaveLength(3);
        });

        it('getOldestSeq advances as entries are evicted', () => {
            const store = new SessionStore(2);
            store.append('a'); // seq 0
            store.append('b'); // seq 1 — evicts nothing yet (size = 2)
            expect(store.getOldestSeq()).toBe(0);

            store.append('c'); // seq 2 — evicts seq 0
            expect(store.getOldestSeq()).toBe(1);

            store.append('d'); // seq 3 — evicts seq 1
            expect(store.getOldestSeq()).toBe(2);
        });

        it('getCurrentSeq keeps incrementing past maxSize', () => {
            const store = new SessionStore(3);
            for (let i = 0; i < 10; i++) store.append(i);
            expect(store.getCurrentSeq()).toBe(9);
        });

        it('getDelta with fromSeq older than oldest returns everything from oldest', () => {
            const store = new SessionStore(3);
            store.append('a'); // seq 0 — will be evicted
            store.append('b'); // seq 1 — will be evicted
            store.append('c'); // seq 2
            store.append('d'); // seq 3  — evicts seq 0
            store.append('e'); // seq 4  — evicts seq 1

            // Client last saw seq 0, but that's been evicted — returns from seq 2 onward
            const delta = store.getDelta(0);
            expect(delta.map(e => e.seq)).toEqual([2, 3, 4]);
        });

        it('buffer never grows beyond maxSize', () => {
            const maxSize = 5;
            const store = new SessionStore(maxSize);
            for (let i = 0; i < 20; i++) store.append(i);
            expect(store.getDelta(-1)).toHaveLength(maxSize);
        });
    });

    describe('default maxSize', () => {
        it('defaults to 200 entries', () => {
            const store = new SessionStore();
            for (let i = 0; i < 201; i++) store.append(i);
            expect(store.getDelta(-1)).toHaveLength(200);
            expect(store.getOldestSeq()).toBe(1);
        });
    });
});

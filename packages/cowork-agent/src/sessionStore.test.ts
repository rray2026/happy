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
});

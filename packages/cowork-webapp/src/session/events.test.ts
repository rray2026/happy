import { beforeEach, describe, expect, it } from 'vitest';
import type {
    AssistantEvent,
    ClaudeEvent,
    Item,
    ResultEvent,
    SystemEvent,
    UserEvent,
} from '../types';
import { __resetUidForTests, eventToItems, mergeItems, uid } from './events';

beforeEach(() => {
    __resetUidForTests();
});

describe('uid', () => {
    it('returns monotonically increasing ids', () => {
        expect(uid()).toBe('1');
        expect(uid()).toBe('2');
        expect(uid()).toBe('3');
    });
});

describe('eventToItems: user events', () => {
    it('converts a string-content user message', () => {
        const ev: UserEvent = { type: 'user', message: { role: 'user', content: 'hello' } };
        expect(eventToItems(ev)).toEqual([{ kind: 'user', text: 'hello', id: '1' }]);
    });

    it('extracts text from structured content', () => {
        const ev: UserEvent = {
            type: 'user',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 't1', content: 'x' },
                    { type: 'text', text: 'hi there' },
                ],
            },
        };
        expect(eventToItems(ev)).toEqual([{ kind: 'user', text: 'hi there', id: '1' }]);
    });

    it('returns no items when user text is empty', () => {
        const ev: UserEvent = { type: 'user', message: { role: 'user', content: '' } };
        expect(eventToItems(ev)).toEqual([]);
    });

    it('returns no items when structured content has no text part', () => {
        const ev: UserEvent = {
            type: 'user',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }],
            },
        };
        expect(eventToItems(ev)).toEqual([]);
    });
});

describe('eventToItems: assistant events', () => {
    it('emits a single assistant item for text-only content', () => {
        const ev: AssistantEvent = {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        };
        expect(eventToItems(ev)).toEqual([{ kind: 'assistant', text: 'answer', id: '1' }]);
    });

    it('concatenates multiple text parts', () => {
        const ev: AssistantEvent = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'foo' },
                    { type: 'text', text: 'bar' },
                ],
            },
        };
        expect(eventToItems(ev)).toEqual([{ kind: 'assistant', text: 'foobar', id: '1' }]);
    });

    it('emits tools item for tool_use parts with name, input, id', () => {
        const ev: AssistantEvent = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
                    { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'foo' } },
                ],
            },
        };
        expect(eventToItems(ev)).toEqual([
            {
                kind: 'tools',
                id: '1',
                calls: [
                    { name: 'Read', input: { file_path: '/x' }, toolUseId: 't1' },
                    { name: 'Grep', input: { pattern: 'foo' }, toolUseId: 't2' },
                ],
            },
        ]);
    });

    it('emits both assistant text and tools items when mixed', () => {
        const ev: AssistantEvent = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'about to run tools' },
                    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
                ],
            },
        };
        expect(eventToItems(ev)).toEqual([
            { kind: 'assistant', text: 'about to run tools', id: '1' },
            {
                kind: 'tools',
                id: '2',
                calls: [{ name: 'Bash', input: { command: 'ls' }, toolUseId: 't1' }],
            },
        ]);
    });

    it('returns no items for empty content', () => {
        const ev: AssistantEvent = {
            type: 'assistant',
            message: { role: 'assistant', content: [] },
        };
        expect(eventToItems(ev)).toEqual([]);
    });
});

describe('eventToItems: result events', () => {
    it('emits failure item for error result', () => {
        const ev: ResultEvent = { type: 'result', subtype: 'error', result: 'boom' };
        expect(eventToItems(ev)).toEqual([
            { kind: 'result', text: 'boom', success: false, id: '1' },
        ]);
    });

    it('falls back to "error" text when result string is empty', () => {
        const ev: ResultEvent = { type: 'result', subtype: 'error', result: '' };
        expect(eventToItems(ev)).toEqual([
            { kind: 'result', text: 'error', success: false, id: '1' },
        ]);
    });

    it('suppresses successful result events (UI already shows them implicitly)', () => {
        const ev: ResultEvent = { type: 'result', subtype: 'success', result: 'ok' };
        expect(eventToItems(ev)).toEqual([]);
    });
});

describe('eventToItems: system events', () => {
    it('emits a truncated session id status', () => {
        const ev: SystemEvent = { type: 'system', subtype: 'init', session_id: 'abcdef123456' };
        expect(eventToItems(ev)).toEqual([
            { kind: 'status', text: 'Session abcdef12…', id: '1' },
        ]);
    });

    it('emits nothing when session_id is missing', () => {
        const ev: SystemEvent = { type: 'system', subtype: 'init' };
        expect(eventToItems(ev)).toEqual([]);
    });
});

describe('eventToItems: unknown events', () => {
    it('returns no items for permission events (handled separately)', () => {
        const ev: ClaudeEvent = { type: 'permission-request' };
        expect(eventToItems(ev)).toEqual([]);
    });

    it('returns no items for unknown event types', () => {
        const ev: ClaudeEvent = { type: 'some-new-type' };
        expect(eventToItems(ev)).toEqual([]);
    });
});

describe('mergeItems', () => {
    it('appends items when prev is empty', () => {
        const incoming: Item[] = [{ kind: 'assistant', text: 'hi', id: 'a' }];
        expect(mergeItems([], incoming)).toEqual(incoming);
    });

    it('coalesces consecutive tools items into one', () => {
        const prev: Item[] = [
            {
                kind: 'tools',
                id: 'p1',
                calls: [{ name: 'Read', input: {}, toolUseId: 't1' }],
            },
        ];
        const incoming: Item[] = [
            {
                kind: 'tools',
                id: 'i1',
                calls: [
                    { name: 'Grep', input: {}, toolUseId: 't2' },
                    { name: 'Bash', input: {}, toolUseId: 't3' },
                ],
            },
        ];
        expect(mergeItems(prev, incoming)).toEqual([
            {
                kind: 'tools',
                id: 'p1',
                calls: [
                    { name: 'Read', input: {}, toolUseId: 't1' },
                    { name: 'Grep', input: {}, toolUseId: 't2' },
                    { name: 'Bash', input: {}, toolUseId: 't3' },
                ],
            },
        ]);
    });

    it('does NOT coalesce tools when separated by another kind', () => {
        const prev: Item[] = [
            {
                kind: 'tools',
                id: 'p1',
                calls: [{ name: 'Read', input: {}, toolUseId: 't1' }],
            },
            { kind: 'assistant', text: 'done', id: 'p2' },
        ];
        const incoming: Item[] = [
            {
                kind: 'tools',
                id: 'i1',
                calls: [{ name: 'Grep', input: {}, toolUseId: 't2' }],
            },
        ];
        expect(mergeItems(prev, incoming)).toEqual([...prev, ...incoming]);
    });

    it('drops duplicate consecutive user messages with identical text', () => {
        const prev: Item[] = [{ kind: 'user', text: 'hello', id: 'p1' }];
        const incoming: Item[] = [{ kind: 'user', text: 'hello', id: 'i1' }];
        expect(mergeItems(prev, incoming)).toEqual(prev);
    });

    it('keeps consecutive user messages with different text', () => {
        const prev: Item[] = [{ kind: 'user', text: 'hello', id: 'p1' }];
        const incoming: Item[] = [{ kind: 'user', text: 'world', id: 'i1' }];
        expect(mergeItems(prev, incoming)).toEqual([...prev, ...incoming]);
    });

    it('does not mutate prev', () => {
        const prev: Item[] = [{ kind: 'assistant', text: 'a', id: 'p1' }];
        const snapshot = structuredClone(prev);
        mergeItems(prev, [{ kind: 'assistant', text: 'b', id: 'i1' }]);
        expect(prev).toEqual(snapshot);
    });
});

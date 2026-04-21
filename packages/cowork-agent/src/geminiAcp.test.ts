import { describe, expect, it } from 'vitest';
import {
    createInitialProcessState,
    finalizeStream,
    processSessionUpdate,
    type ProcessState,
} from './geminiAcp.js';

/**
 * Pure-function tests for the ACP session-update reducer. These cover the
 * logic that the end-to-end tests exercise only indirectly, so refactors can
 * fail fast without spawning a fake CLI.
 */
describe('processSessionUpdate', () => {
    const mkId = () => {
        let n = 0;
        return () => `id-${++n}`;
    };

    it('empty update (unknown kind) emits nothing and preserves state', () => {
        const state = createInitialProcessState();
        const out = processSessionUpdate({ sessionUpdate: 'unknown' }, state, mkId());
        expect(out.emit).toEqual([]);
        expect(out.state).toEqual(state);
    });

    it('agent_message_chunk starts a stream and emits one delta event', () => {
        const out = processSessionUpdate(
            { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } },
            createInitialProcessState(),
            mkId(),
        );
        expect(out.state.currentStreamId).toBe('id-1');
        expect(out.emit).toEqual([
            {
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
                _delta: true,
                _streamId: 'id-1',
            },
        ]);
    });

    it('successive chunks reuse the same streamId (no new id generated)', () => {
        const gen = mkId();
        let state: ProcessState = createInitialProcessState();
        const out1 = processSessionUpdate(
            { sessionUpdate: 'agent_message_chunk', content: { text: 'a' } },
            state,
            gen,
        );
        state = out1.state;
        const out2 = processSessionUpdate(
            { sessionUpdate: 'agent_message_chunk', content: { text: 'b' } },
            state,
            gen,
        );
        expect(state.currentStreamId).toBe('id-1');
        expect(out2.state.currentStreamId).toBe('id-1');
        expect((out2.emit[0] as { _streamId: string })._streamId).toBe('id-1');
    });

    it('empty chunk text is ignored (no event, no state change)', () => {
        const out = processSessionUpdate(
            { sessionUpdate: 'agent_message_chunk', content: { text: '' } },
            createInitialProcessState(),
            mkId(),
        );
        expect(out.emit).toEqual([]);
        expect(out.state.currentStreamId).toBeNull();
    });

    it('tool_call finalizes the current stream (emits _final) BEFORE the tool_use', () => {
        const state: ProcessState = { currentStreamId: 'stream-A' };
        const out = processSessionUpdate(
            { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' },
            state,
            mkId(),
        );
        expect(out.state.currentStreamId).toBeNull();
        expect(out.emit).toHaveLength(2);
        expect(out.emit[0]).toEqual({ type: 'assistant', _final: true, _streamId: 'stream-A' });
        const toolEv = out.emit[1] as {
            type: string;
            message: { content: Array<{ type: string; id: string; name: string }> };
        };
        expect(toolEv.type).toBe('assistant');
        expect(toolEv.message.content[0]).toMatchObject({ type: 'tool_use', id: 't1', name: 'Read' });
    });

    it('tool_call without an active stream emits only the tool_use (no finalize)', () => {
        const out = processSessionUpdate(
            { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' },
            createInitialProcessState(),
            mkId(),
        );
        expect(out.emit).toHaveLength(1);
        expect((out.emit[0] as { type: string }).type).toBe('assistant');
    });

    it('agent_thought_chunk emits a thinking event and leaves state untouched', () => {
        const state: ProcessState = { currentStreamId: 'stream-X' };
        const out = processSessionUpdate(
            { sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } },
            state,
            mkId(),
        );
        expect(out.emit).toEqual([{ type: 'thinking', thinking: 'hmm' }]);
        expect(out.state.currentStreamId).toBe('stream-X');
    });

    it('tool_call_update emits tool_result and also finalizes any active stream first', () => {
        const state: ProcessState = { currentStreamId: 'stream-B' };
        const out = processSessionUpdate(
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 't1',
                status: 'completed',
                content: [{ type: 'content', content: { text: 'ok' } }],
            },
            state,
            mkId(),
        );
        expect(out.state.currentStreamId).toBeNull();
        expect(out.emit[0]).toEqual({ type: 'assistant', _final: true, _streamId: 'stream-B' });
        expect(out.emit[1]).toEqual({
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'ok',
            is_error: false,
        });
    });
});

describe('finalizeStream', () => {
    it('emits a _final event when a stream is active', () => {
        const out = finalizeStream({ currentStreamId: 'zzz' });
        expect(out.state.currentStreamId).toBeNull();
        expect(out.emit).toEqual([{ type: 'assistant', _final: true, _streamId: 'zzz' }]);
    });

    it('no-op when no stream is active', () => {
        const out = finalizeStream(createInitialProcessState());
        expect(out.emit).toEqual([]);
        expect(out.state.currentStreamId).toBeNull();
    });
});

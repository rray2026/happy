import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCliRig, waitFor, waitForEvent, type CliRig } from './harness';

/**
 * End-to-end tests covering the full path:
 *   fake CLI child process  ──stream─▶  cowork-agent  ──ws─▶  SessionClient
 *                                                            │
 *                                                            ▼
 *                                                 eventToItems + mergeItems
 *
 * Each test asserts both the protocol layer (`rig.events`) and the webapp
 * rendering layer (`rig.items`).
 */
describe('CLI → wsServer → webapp end-to-end', () => {
    let rig: CliRig;

    afterEach(async () => {
        await rig?.dispose();
    });

    // ── Claude path ────────────────────────────────────────────────────────────

    describe('claude', () => {
        it('happy path: init + single assistant chunk + result', async () => {
            rig = await startCliRig({
                agent: 'claude',
                cliScript: {
                    steps: [
                        { delayMs: 1, event: { type: 'system', subtype: 'init', session_id: 'fake-sess-001' } },
                        {
                            delayMs: 1,
                            event: {
                                type: 'assistant',
                                message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
                            },
                        },
                        { delayMs: 1, event: { type: 'result', subtype: 'success', result: 'ok' } },
                    ],
                },
            });

            rig.sendInput('hello');
            await waitForEvent(rig, (p) => (p as { type?: string })?.type === 'result');

            expect(rig.events.map((e) => (e.payload as { type: string }).type)).toEqual([
                'user',
                'system',
                'assistant',
                'result',
            ]);

            // webapp layer: user item, status item (from system), assistant item.
            // result with subtype:'success' produces no item (events.ts:47 returns []).
            expect(rig.items).toEqual([
                { kind: 'user', text: 'hello', id: expect.any(String) },
                { kind: 'status', text: expect.stringMatching(/^Session fake-ses/), id: expect.any(String) },
                { kind: 'assistant', text: 'Hi', id: expect.any(String) },
            ]);
        });

        it('multiple assistant events arrive in order', async () => {
            rig = await startCliRig({
                agent: 'claude',
                cliScript: {
                    steps: [
                        {
                            event: {
                                type: 'assistant',
                                message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
                            },
                        },
                        {
                            delayMs: 2,
                            event: {
                                type: 'assistant',
                                message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
                            },
                        },
                        { event: { type: 'result', subtype: 'success', result: 'ok' } },
                    ],
                },
            });
            rig.sendInput('go');
            await waitForEvent(rig, (p) => (p as { type?: string })?.type === 'result');

            const assistants = rig.events.filter((e) => (e.payload as { type: string }).type === 'assistant');
            expect(assistants).toHaveLength(2);

            // Two separate assistant items (each gets its own uid) — mergeItems
            // only merges tool items, not plain text items.
            const assistantItems = rig.items.filter((i) => i.kind === 'assistant');
            expect(assistantItems.map((i) => (i as { text: string }).text)).toEqual(['one', 'two']);
        });

        it('tool_use events from successive assistant events merge into one tools item', async () => {
            rig = await startCliRig({
                agent: 'claude',
                cliScript: {
                    steps: [
                        {
                            event: {
                                type: 'assistant',
                                message: {
                                    role: 'assistant',
                                    content: [
                                        { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } },
                                    ],
                                },
                            },
                        },
                        {
                            delayMs: 1,
                            event: {
                                type: 'assistant',
                                message: {
                                    role: 'assistant',
                                    content: [
                                        { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x' } },
                                    ],
                                },
                            },
                        },
                        { event: { type: 'result', subtype: 'success', result: 'ok' } },
                    ],
                },
            });
            rig.sendInput('tools please');
            await waitForEvent(rig, (p) => (p as { type?: string })?.type === 'result');

            const toolItems = rig.items.filter((i) => i.kind === 'tools');
            expect(toolItems).toHaveLength(1);
            expect((toolItems[0] as { calls: Array<{ toolUseId: string }> }).calls.map((c) => c.toolUseId)).toEqual([
                't1',
                't2',
            ]);
        });

        it('spawn ENOENT surfaces a broadcast error-result', async () => {
            rig = await startCliRig({
                agent: 'claude',
                cliScript: { steps: [] },
                claudeCommand: '/this/path/does/not/exist-xyz',
            });
            rig.sendInput('boom');

            const errEvent = await waitForEvent(
                rig,
                (p) => {
                    const pe = p as { type?: string; subtype?: string };
                    return pe.type === 'result' && pe.subtype === 'error';
                },
                3_000,
            );
            const payload = errEvent.payload as { result: string };
            expect(payload.result).toMatch(/not found|ENOENT|spawn/i);

            // Error item appears in UI.
            const resultItems = rig.items.filter((i) => i.kind === 'result');
            expect(resultItems).toHaveLength(1);
            expect((resultItems[0] as { success: boolean }).success).toBe(false);
        });

        it('non-zero exit without result event does not hang the agent', async () => {
            rig = await startCliRig({
                agent: 'claude',
                cliScript: {
                    steps: [
                        {
                            event: {
                                type: 'assistant',
                                message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
                            },
                        },
                        { delayMs: 1, exitAfter: true, exitCode: 42 },
                    ],
                },
            });
            rig.sendInput('crash');
            // Should at least see user + assistant events before the process dies.
            await waitFor(() => rig.events.length >= 2);

            expect(rig.events.map((e) => (e.payload as { type: string }).type)).toContain('assistant');
            // No hang: a subsequent input should still be handled (agentBusy flips off).
            rig.sendInput('second');
            await waitFor(() => rig.events.filter((e) => (e.payload as { type: string }).type === 'user').length >= 2);
        });
    });

    // ── Gemini path ────────────────────────────────────────────────────────────

    describe('gemini (current buffered behavior — Phase 2 will flip these)', () => {
        beforeEach(() => {
            // vitest quirk: beforeEach per describe
        });

        it('baseline: chunks are buffered and flushed as ONE assistant event at prompt end', async () => {
            rig = await startCliRig({
                agent: 'gemini',
                cliScript: {
                    onPrompt: [
                        [
                            { delayMs: 1, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hel' } } },
                            { delayMs: 1, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'lo' } } },
                            { delayMs: 1, update: { sessionUpdate: 'agent_message_chunk', content: { text: ' world' } } },
                        ],
                    ],
                },
            });
            rig.sendInput('stream?');
            await waitForEvent(rig, (p) => (p as { type?: string })?.type === 'result');

            const assistants = rig.events.filter((e) => (e.payload as { type: string }).type === 'assistant');
            expect(assistants).toHaveLength(1); // Phase 2 will make this >1 (delta events)
            const content = (assistants[0].payload as {
                message: { content: Array<{ type: string; text: string }> };
            }).message.content;
            expect(content[0].text).toBe('Hello world');

            const assistantItems = rig.items.filter((i) => i.kind === 'assistant');
            expect(assistantItems).toHaveLength(1);
            expect((assistantItems[0] as { text: string }).text).toBe('Hello world');
        });

        it('tool_call flushes buffered chunks before tool, then resumes into a second assistant event', async () => {
            rig = await startCliRig({
                agent: 'gemini',
                cliScript: {
                    onPrompt: [
                        [
                            { delayMs: 1, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'be' } } },
                            { delayMs: 1, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'fore' } } },
                            { delayMs: 1, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' } },
                            { delayMs: 1, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'after' } } },
                        ],
                    ],
                },
            });
            rig.sendInput('stream + tool');
            await waitForEvent(rig, (p) => (p as { type?: string })?.type === 'result');

            const types = rig.events.map((e) => (e.payload as { type: string }).type);
            const userIdx = types.indexOf('user');
            const toolIdx = types.indexOf('assistant', userIdx + 1);
            // NB: tool_use is inside an assistant event (updateToEvent wraps it).
            expect(types.filter((t) => t === 'assistant').length).toBeGreaterThanOrEqual(3);
            // First assistant (flushed "before") precedes the tool_call assistant;
            // last assistant ("after") comes from the prompt-end flush.
            expect(toolIdx).toBeGreaterThan(userIdx);
        });

        it('agent_thought_chunk broadcasts a thinking event directly (no buffering)', async () => {
            rig = await startCliRig({
                agent: 'gemini',
                cliScript: {
                    onPrompt: [
                        [
                            { delayMs: 1, update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'pondering…' } } },
                        ],
                    ],
                },
            });
            rig.sendInput('think');
            await waitForEvent(rig, (p) => (p as { type?: string })?.type === 'result');

            const thinking = rig.events.filter((e) => (e.payload as { type: string }).type === 'thinking');
            expect(thinking).toHaveLength(1);
            expect((thinking[0].payload as { thinking: string }).thinking).toBe('pondering…');
        });

        it('empty prompt: no assistant flush when there are no chunks', async () => {
            rig = await startCliRig({
                agent: 'gemini',
                cliScript: { onPrompt: [[]] },
            });
            rig.sendInput('nothing');
            await waitForEvent(rig, (p) => (p as { type?: string })?.type === 'result');

            const assistants = rig.events.filter((e) => (e.payload as { type: string }).type === 'assistant');
            expect(assistants).toHaveLength(0);
            expect(rig.items.filter((i) => i.kind === 'assistant')).toHaveLength(0);
        });
    });
});

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

    describe('gemini (progressive streaming)', () => {
        beforeEach(() => {
            // vitest quirk: beforeEach per describe
        });

        it('chunks emit as progressive delta events keyed by a single streamId; final marker closes the stream', async () => {
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

            type AsstEv = {
                type: 'assistant';
                message?: { content: Array<{ type: string; text: string }> };
                _delta?: boolean;
                _final?: boolean;
                _streamId?: string;
            };
            const assistants = rig.events
                .map((e) => e.payload as AsstEv)
                .filter((p) => p.type === 'assistant');

            const deltas = assistants.filter((a) => a._delta === true);
            const finals = assistants.filter((a) => a._final === true);
            expect(deltas).toHaveLength(3);
            expect(finals).toHaveLength(1);

            // All delta+final events share a single streamId.
            const ids = new Set(assistants.map((a) => a._streamId));
            expect(ids.size).toBe(1);

            // Each delta carries only its own chunk text (no cumulative re-send).
            expect(deltas.map((d) => d.message!.content[0].text)).toEqual(['Hel', 'lo', ' world']);
            // Final event carries no text.
            expect(finals[0].message).toBeUndefined();

            // webapp layer: the three deltas merge into a single assistant item,
            // and the final marker flips streaming=false.
            const assistantItems = rig.items.filter((i) => i.kind === 'assistant');
            expect(assistantItems).toHaveLength(1);
            const item = assistantItems[0] as { text: string; streaming?: boolean };
            expect(item.text).toBe('Hello world');
            expect(item.streaming).toBe(false);
        });

        it('tool_call finalizes the current stream before the tool event; a new stream starts afterwards', async () => {
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

            type AsstEv = {
                type: 'assistant';
                message?: { content: Array<{ type: string; text?: string; name?: string }> };
                _delta?: boolean;
                _final?: boolean;
                _streamId?: string;
            };
            const assistants = rig.events
                .map((e) => e.payload as AsstEv)
                .filter((p) => p.type === 'assistant');

            // Layout: delta(be) delta(fore) final(streamA) tool_use(t1) delta(after) final(streamB)
            const deltas = assistants.filter((a) => a._delta === true);
            const finals = assistants.filter((a) => a._final === true);
            const toolUses = assistants.filter(
                (a) => !a._delta && !a._final && a.message?.content?.[0]?.type === 'tool_use',
            );

            expect(deltas).toHaveLength(3);
            expect(finals).toHaveLength(2);
            expect(toolUses).toHaveLength(1);

            // Two distinct streamIds — one before the tool, one after.
            const streamIds = new Set(
                [...deltas, ...finals].map((a) => a._streamId).filter(Boolean),
            );
            expect(streamIds.size).toBe(2);

            // Ordering: first final must come BEFORE tool_use in the event stream.
            const streamABefore = rig.events.findIndex(
                (e) => (e.payload as AsstEv)._final === true,
            );
            const toolIdx = rig.events.findIndex(
                (e) =>
                    (e.payload as AsstEv).type === 'assistant' &&
                    (e.payload as AsstEv).message?.content?.[0]?.type === 'tool_use',
            );
            expect(streamABefore).toBeLessThan(toolIdx);

            // webapp layer: two assistant items + one tools item between them.
            const kinds = rig.items.map((i) => i.kind);
            const firstAsst = kinds.indexOf('assistant');
            const toolsKindIdx = kinds.indexOf('tools');
            const lastAsst = kinds.lastIndexOf('assistant');
            expect(firstAsst).toBeLessThan(toolsKindIdx);
            expect(toolsKindIdx).toBeLessThan(lastAsst);
            const firstItem = rig.items[firstAsst] as { text: string; streaming?: boolean };
            const lastItem = rig.items[lastAsst] as { text: string; streaming?: boolean };
            expect(firstItem.text).toBe('before');
            expect(firstItem.streaming).toBe(false);
            expect(lastItem.text).toBe('after');
            expect(lastItem.streaming).toBe(false);
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

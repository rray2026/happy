import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeChannel, type ClaudeChannelOptions } from './claudeProcess.js';

const FAKE_BIN = fileURLToPath(
    new URL('./__fixtures__/fake-claude-stream.mjs', import.meta.url),
);

interface Harness {
    events: Array<Record<string, unknown>>;
    sessionIds: string[];
    deaths: string[];
    channel: ClaudeChannel;
    dispose: () => Promise<void>;
}

function makeChannel(overrides: Partial<ClaudeChannelOptions> = {}): Harness {
    const events: Array<Record<string, unknown>> = [];
    const sessionIds: string[] = [];
    const deaths: string[] = [];
    const channel = new ClaudeChannel({
        resumeSessionId: null,
        model: undefined,
        agentArgs: [],
        cwd: '/tmp',
        onEvent: (e) => events.push(e as Record<string, unknown>),
        onSessionId: (id) => sessionIds.push(id),
        onChannelDeath: (reason) => deaths.push(reason),
        // The fake script ignores argv (only reads stdin), so passing it as
        // the command lets ClaudeChannel's --print/--input-format flags land
        // in argv harmlessly.
        command: FAKE_BIN,
        ...overrides,
    });
    return {
        events,
        sessionIds,
        deaths,
        channel,
        async dispose() {
            await channel.close();
        },
    };
}

function nextResult(events: Array<Record<string, unknown>>, fromIndex = 0): number {
    for (let i = fromIndex; i < events.length; i++) {
        if (events[i].type === 'result') return i;
    }
    return -1;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('waitFor timed out');
}

describe('ClaudeChannel — basic IO', () => {
    let h: Harness;
    afterEach(async () => h?.dispose());

    it('processes a single prompt and resolves send()', async () => {
        h = makeChannel();
        await h.channel.send('hi');
        const idx = nextResult(h.events);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect((h.events[idx] as { result: string }).result).toContain('hi');
    });

    it('forwards system/init, assistant, and result events in order', async () => {
        h = makeChannel();
        await h.channel.send('alpha');
        const types = h.events.map((e) => `${e.type}/${e.subtype ?? ''}`);
        expect(types[0]).toBe('system/init');
        expect(types[1]).toBe('assistant/');
        expect(types[2]).toBe('result/success');
    });

    it('captures session_id via onSessionId', async () => {
        h = makeChannel();
        await h.channel.send('__SESSION__:abcdef');
        expect(h.sessionIds.length).toBeGreaterThan(0);
        expect(h.sessionIds[0]).toBe('abcdef');
    });

    it('does not forward control_response to onEvent', async () => {
        h = makeChannel();
        await h.channel.send('__SLOW__:50:turn');
        // No interrupt was sent, so no control_response should appear anyway.
        // Real check happens in the abort tests; here we just sanity-check the
        // event stream has no control_response leakage.
        const types = h.events.map((e) => e.type);
        expect(types).not.toContain('control_response');
    });
});

describe('ClaudeChannel — queue + busy tracking', () => {
    let h: Harness;
    afterEach(async () => h?.dispose());

    it('serializes back-to-back send() calls — second waits for first result', async () => {
        h = makeChannel();
        const p1 = h.channel.send('__SLOW__:80:first');
        // Second send before first resolves: should queue, not interleave on stdin.
        const p2 = h.channel.send('second');
        expect(h.channel.pendingCount()).toBe(1);
        expect(h.channel.isBusy()).toBe(true);

        await Promise.all([p1, p2]);
        // Two result events, in the order the prompts were sent.
        const results = h.events.filter((e) => e.type === 'result');
        expect(results).toHaveLength(2);
        expect((results[0] as { result: string }).result).toContain('first');
        expect((results[1] as { result: string }).result).toContain('second');
    });

    it('isBusy() returns false after the result event arrives', async () => {
        h = makeChannel();
        await h.channel.send('quick');
        expect(h.channel.isBusy()).toBe(false);
        expect(h.channel.pendingCount()).toBe(0);
    });
});

describe('ClaudeChannel — abort', () => {
    let h: Harness;
    afterEach(async () => h?.dispose());

    it('idle abort is a no-op (control_response only, no result event)', async () => {
        h = makeChannel();
        // Wait for child to be ready by sending and resolving one short prompt.
        await h.channel.send('warmup');
        const before = h.events.length;
        await h.channel.abort();
        // No new events should be forwarded (control_response is internal).
        expect(h.events.length).toBe(before);
    });

    it('aborts an in-flight long-running turn and emits result/error_during_execution', async () => {
        h = makeChannel();
        const p = h.channel.send('__NO_RESULT__:never');
        // wait until the child has emitted system/init for this turn
        await waitFor(() => h.events.some((e) => e.type === 'system' && e.subtype === 'init'));
        expect(h.channel.isBusy()).toBe(true);

        await h.channel.abort();
        await p; // resolves once result/error_during_execution arrives
        const result = h.events.find((e) => e.type === 'result') as
            | { subtype: string }
            | undefined;
        expect(result?.subtype).toBe('error_during_execution');
        expect(h.channel.isBusy()).toBe(false);
    });

    it('drains queued prompts as result/error events on abort', async () => {
        h = makeChannel();
        const p1 = h.channel.send('__NO_RESULT__:in-flight');
        const p2 = h.channel.send('queued-1');
        const p3 = h.channel.send('queued-2');
        expect(h.channel.pendingCount()).toBe(2);

        await waitFor(() => h.channel.isBusy());
        await h.channel.abort();
        await Promise.all([p1, p2, p3]);

        const errorResults = h.events.filter(
            (e) => e.type === 'result' && (e.subtype === 'error' || e.subtype === 'error_during_execution'),
        );
        // 2 'aborted before dispatch' for the queue + 1 error_during_execution for the in-flight.
        expect(errorResults).toHaveLength(3);
        const drainedCount = errorResults.filter(
            (e) => (e as { result: string }).result === 'aborted before dispatch',
        ).length;
        expect(drainedCount).toBe(2);
    });

    it('a follow-up send() after abort runs normally', async () => {
        h = makeChannel();
        const aborted = h.channel.send('__NO_RESULT__:long');
        await waitFor(() => h.channel.isBusy());
        await h.channel.abort();
        await aborted;

        await h.channel.send('after-abort');
        const lastResult = h.events.filter((e) => e.type === 'result').pop() as
            | { subtype: string; result: string }
            | undefined;
        expect(lastResult?.subtype).toBe('success');
        expect(lastResult?.result).toContain('after-abort');
    });
});

describe('ClaudeChannel — death paths', () => {
    let h: Harness;
    afterEach(async () => h?.dispose());

    it('marks channel dead when child crashes mid-turn and rejects pending sends', async () => {
        h = makeChannel();
        let rejected: Error | null = null;
        const p = h.channel.send('__CRASH__').catch((e) => {
            rejected = e as Error;
        });
        await p; // resolves regardless because we caught
        await waitFor(() => h.deaths.length > 0);
        expect(h.deaths.length).toBe(1);
        expect(rejected).toBeInstanceOf(Error);
    });

    it('rejects send() when channel is already dead', async () => {
        h = makeChannel();
        await h.channel.send('warmup');
        await h.channel.close();
        await expect(h.channel.send('after-close')).rejects.toThrow();
    });

    it('onChannelDeath fires exactly once even after multiple paths trigger', async () => {
        const onDeath = vi.fn();
        h = makeChannel({ onChannelDeath: onDeath });
        await h.channel.send('warmup');
        await h.channel.close();
        // close also triggers death; another close shouldn't double-fire.
        await h.channel.close();
        expect(onDeath).toHaveBeenCalledTimes(1);
    });
});

describe('ClaudeChannel — close', () => {
    let h: Harness;
    afterEach(async () => h?.dispose());

    it('close() resolves cleanly when the channel is idle', async () => {
        h = makeChannel();
        await h.channel.send('warmup');
        await expect(h.channel.close()).resolves.toBeUndefined();
        expect(h.channel.isBusy()).toBe(false);
    });
});

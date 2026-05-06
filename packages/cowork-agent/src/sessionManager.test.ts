import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type SessionMeta } from './sessionManager.js';
import type { PersistedSession } from './sessionStorage.js';

const FAKE_CLAUDE = fileURLToPath(
    new URL('./__fixtures__/fake-claude-stream.mjs', import.meta.url),
);

function makeManager(overrides: {
    onPersist?: (s: PersistedSession) => void;
    onPersistRemove?: (id: string) => void;
    onSessionsChanged?: (list: unknown[]) => void;
} = {}) {
    return new SessionManager({
        cwd: '/tmp/project',
        onBroadcast: () => {},
        onSessionsChanged: overrides.onSessionsChanged,
        onPersist: overrides.onPersist,
        onPersistRemove: overrides.onPersistRemove,
    });
}

describe('SessionManager persistence hooks', () => {
    it('fires onPersist on create with the session shape', () => {
        const onPersist = vi.fn();
        const mgr = makeManager({ onPersist });

        const meta = mgr.create({ tool: 'claude', model: 'sonnet', agentArgs: ['--foo'] });

        expect(onPersist).toHaveBeenCalledTimes(1);
        const persisted = onPersist.mock.calls[0][0] as PersistedSession;
        expect(persisted.id).toBe(meta.id);
        expect(persisted.tool).toBe('claude');
        expect(persisted.model).toBe('sonnet');
        expect(persisted.agentArgs).toEqual(['--foo']);
        expect(persisted.cwd).toBe('/tmp/project');
        expect(persisted.claudeSessionId).toBeNull();
        expect(persisted.geminiSessionId).toBeNull();
    });

    it('fires onPersistRemove on close', () => {
        const onPersistRemove = vi.fn();
        const mgr = makeManager({ onPersistRemove });

        const { id } = mgr.create({ tool: 'claude' });
        mgr.close(id);

        expect(onPersistRemove).toHaveBeenCalledWith(id);
    });

    it('does not fire onPersistRemove when close() is called on unknown id', () => {
        const onPersistRemove = vi.fn();
        const mgr = makeManager({ onPersistRemove });

        expect(mgr.close('unknown-id')).toBe(false);
        expect(onPersistRemove).not.toHaveBeenCalled();
    });
});

describe('SessionManager rehydrate', () => {
    function persisted(overrides: Partial<PersistedSession> = {}): PersistedSession {
        return {
            id: randomUUID(),
            tool: 'claude',
            model: undefined,
            cwd: '/tmp/project',
            createdAt: 1_700_000_000_000,
            agentArgs: [],
            claudeSessionId: null,
            geminiSessionId: null,
            ...overrides,
        };
    }

    it('restores sessions into the list without firing onPersist', () => {
        const onPersist = vi.fn();
        const mgr = makeManager({ onPersist });

        const a = persisted({ tool: 'claude', claudeSessionId: 'cid-1' });
        const b = persisted({ tool: 'gemini', geminiSessionId: 'acp-1' });
        mgr.rehydrate([a, b]);

        const list = mgr.list();
        expect(list.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
        // Rehydrate should not re-write what it just read.
        expect(onPersist).not.toHaveBeenCalled();
    });

    it('fires onSessionsChanged exactly once for a non-empty rehydrate', () => {
        const onSessionsChanged = vi.fn();
        const mgr = makeManager({ onSessionsChanged });

        mgr.rehydrate([persisted(), persisted()]);

        expect(onSessionsChanged).toHaveBeenCalledTimes(1);
    });

    it('does not fire onSessionsChanged for an empty rehydrate', () => {
        const onSessionsChanged = vi.fn();
        const mgr = makeManager({ onSessionsChanged });

        mgr.rehydrate([]);

        expect(onSessionsChanged).not.toHaveBeenCalled();
    });

    it('skips sessions from a different cwd as a safety net', () => {
        const mgr = makeManager();

        mgr.rehydrate([
            persisted({ cwd: '/tmp/project' }),
            persisted({ cwd: '/tmp/elsewhere' }),
        ]);

        expect(mgr.list()).toHaveLength(1);
        expect(mgr.list()[0].cwd).toBe('/tmp/project');
    });

    it('preserves stored model + agentArgs on restored sessions', () => {
        const mgr = makeManager();
        const p = persisted({
            tool: 'claude',
            model: 'opus',
            agentArgs: ['--flag', 'value'],
        });

        mgr.rehydrate([p]);

        const meta = mgr.get(p.id)!;
        expect(meta).not.toBeNull();
        expect(meta.model).toBe('opus');
        expect(meta.tool).toBe('claude');
    });

    it('skips duplicates if rehydrate is called twice', () => {
        const mgr = makeManager();
        const p = persisted();
        mgr.rehydrate([p]);
        mgr.rehydrate([p]);

        expect(mgr.list()).toHaveLength(1);
    });

    it('close on a rehydrated session fires onPersistRemove', () => {
        const onPersistRemove = vi.fn();
        const mgr = makeManager({ onPersistRemove });
        const p = persisted();

        mgr.rehydrate([p]);
        expect(mgr.close(p.id)).toBe(true);

        expect(onPersistRemove).toHaveBeenCalledWith(p.id);
    });

    it('accepts a subdirectory cwd on rehydrate (inside root)', () => {
        const mgr = makeManager();
        const p = persisted({ cwd: '/tmp/project/packages/foo' });

        mgr.rehydrate([p]);

        expect(mgr.list()).toHaveLength(1);
        expect(mgr.list()[0].cwd).toBe('/tmp/project/packages/foo');
    });

    it('rejects a cwd that is a sibling of root on rehydrate', () => {
        const mgr = makeManager();
        // /tmp/projectile shares the prefix /tmp/project but is not inside.
        mgr.rehydrate([persisted({ cwd: '/tmp/projectile' })]);

        expect(mgr.list()).toHaveLength(0);
    });
});

describe('SessionManager per-session cwd', () => {
    it('create() with cwd option persists that cwd', () => {
        const onPersist = vi.fn();
        const mgr = new SessionManager({
            cwd: '/tmp/project',
            onBroadcast: () => {},
            onPersist,
        });

        const meta = mgr.create({ tool: 'claude', cwd: '/tmp/project/packages/webapp' });

        expect(meta.cwd).toBe('/tmp/project/packages/webapp');
        const persisted = onPersist.mock.calls[0][0] as PersistedSession;
        expect(persisted.cwd).toBe('/tmp/project/packages/webapp');
    });

    it('create() with no cwd falls back to manager root', () => {
        const mgr = new SessionManager({ cwd: '/tmp/project', onBroadcast: () => {} });

        const meta = mgr.create({ tool: 'claude' });

        expect(meta.cwd).toBe('/tmp/project');
    });

    it('create() rejects a cwd that escapes the manager root', () => {
        const mgr = new SessionManager({ cwd: '/tmp/project', onBroadcast: () => {} });

        expect(() => mgr.create({ tool: 'claude', cwd: '/tmp/elsewhere' })).toThrow(
            /escapes agent root/,
        );
    });

    it('create() rejects a sibling path that only shares the prefix string', () => {
        const mgr = new SessionManager({ cwd: '/tmp/project', onBroadcast: () => {} });

        expect(() => mgr.create({ tool: 'claude', cwd: '/tmp/projectile' })).toThrow(
            /escapes agent root/,
        );
    });
});

describe('SessionManager — claude channel path', () => {
    interface ChannelHarness {
        manager: SessionManager;
        broadcasts: Array<{ sessionId: string; payload: unknown }>;
        sessionsChanges: SessionMeta[][];
    }

    function makeChannelManager(): ChannelHarness {
        const broadcasts: Array<{ sessionId: string; payload: unknown }> = [];
        const sessionsChanges: SessionMeta[][] = [];
        const manager = new SessionManager({
            cwd: '/tmp',
            onBroadcast: (sid, _seq, payload) => broadcasts.push({ sessionId: sid, payload }),
            onSessionsChanged: (list) => sessionsChanges.push([...list]),
            useClaudeChannel: true,
            claudeCommand: FAKE_CLAUDE,
        });
        return { manager, broadcasts, sessionsChanges };
    }

    async function waitForResultBroadcast(
        broadcasts: Array<{ payload: unknown }>,
        prevCount: number,
        timeoutMs = 3000,
    ) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const newOnes = broadcasts.slice(prevCount);
            if (newOnes.some((b) => (b.payload as { type?: string })?.type === 'result')) return;
            await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('timed out waiting for result broadcast');
    }

    let h: ChannelHarness;
    afterEach(() => h?.manager.dispose());

    it('routes handleInput through ClaudeChannel and broadcasts result events', async () => {
        h = makeChannelManager();
        const meta = h.manager.create({ tool: 'claude' });
        const before = h.broadcasts.length;

        await h.manager.handleInput(meta.id, 'hello');
        await waitForResultBroadcast(h.broadcasts, before);

        const types = h.broadcasts.slice(before).map((b) => (b.payload as { type?: string })?.type);
        // user (echo from manager) + system/init + assistant + result
        expect(types).toContain('user');
        expect(types).toContain('system');
        expect(types).toContain('assistant');
        expect(types).toContain('result');
    });

    it('SessionMeta exposes busy + pending and emits sessionsChanged on transitions', async () => {
        h = makeChannelManager();
        const meta = h.manager.create({ tool: 'claude' });

        await h.manager.handleInput(meta.id, '__SLOW__:80:turn');
        // After dispatch, the channel should be busy.
        const live = h.manager.list().find((m) => m.id === meta.id)!;
        expect(live.busy).toBe(true);

        // Wait until busy flips back to false (cold-spawn + 80ms slow + event prop).
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            const cur = h.manager.list().find((m) => m.id === meta.id)!;
            if (!cur.busy) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        const settled = h.manager.list().find((m) => m.id === meta.id)!;
        expect(settled.busy).toBe(false);
        expect(settled.pending).toBe(0);

        // sessionsChanged should have fired at least twice: once on dispatch (pending changed),
        // once on result (busy reset).
        expect(h.sessionsChanges.length).toBeGreaterThanOrEqual(2);
    });

    it('queues a second handleInput while the first turn is in flight', async () => {
        h = makeChannelManager();
        const meta = h.manager.create({ tool: 'claude' });

        await h.manager.handleInput(meta.id, '__SLOW__:120:first');
        await h.manager.handleInput(meta.id, 'second');

        // Both should eventually produce result events.
        const before = 0;
        const start = Date.now();
        while (Date.now() - start < 3000) {
            const resultCount = h.broadcasts.filter(
                (b) => (b.payload as { type?: string })?.type === 'result',
            ).length;
            if (resultCount >= 2) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        const results = h.broadcasts
            .filter((b) => (b.payload as { type?: string })?.type === 'result')
            .map((b) => (b.payload as { result: string }).result);
        expect(results).toHaveLength(2);
        expect(results[0]).toContain('first');
        expect(results[1]).toContain('second');
    });

    it('abort() interrupts in-flight turn and the session continues to accept input', async () => {
        h = makeChannelManager();
        const meta = h.manager.create({ tool: 'claude' });

        await h.manager.handleInput(meta.id, '__NO_RESULT__:hung');
        // Wait for system/init to confirm the turn started.
        await new Promise((r) => setTimeout(r, 100));

        h.manager.abort(meta.id);

        // Wait for result/error_during_execution to land.
        const start = Date.now();
        while (Date.now() - start < 3000) {
            const found = h.broadcasts.some(
                (b) => {
                    const p = b.payload as { type?: string; subtype?: string };
                    return p?.type === 'result' && p?.subtype === 'error_during_execution';
                },
            );
            if (found) break;
            await new Promise((r) => setTimeout(r, 10));
        }

        // Follow-up input should be processed normally.
        const before = h.broadcasts.length;
        await h.manager.handleInput(meta.id, 'after-abort');
        await waitForResultBroadcast(h.broadcasts, before);
    });
});

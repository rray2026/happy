import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from './sessionManager.js';
import type { PersistedSession } from './sessionStorage.js';

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
});

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    loadAllSessions,
    removeSession,
    saveSession,
    type PersistedSession,
} from './sessionStorage.js';

function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
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

describe('sessionStorage', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cowork-sessions-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    describe('saveSession + loadAllSessions round-trip', () => {
        it('persists a claude session and restores it when cwd matches', () => {
            const s = makeSession({ tool: 'claude', claudeSessionId: 'claude-abc' });
            saveSession(dir, s);

            const loaded = loadAllSessions(dir, '/tmp/project');
            expect(loaded).toEqual([s]);
        });

        it('persists a gemini session with its ACP id', () => {
            const s = makeSession({
                tool: 'gemini',
                model: 'gemini-2.5-pro',
                geminiSessionId: 'acp-xyz',
            });
            saveSession(dir, s);

            const loaded = loadAllSessions(dir, '/tmp/project');
            expect(loaded).toEqual([s]);
        });

        it('overwrites an existing file for the same id', () => {
            const id = randomUUID();
            saveSession(dir, makeSession({ id, claudeSessionId: null }));
            saveSession(dir, makeSession({ id, claudeSessionId: 'new-id' }));

            const loaded = loadAllSessions(dir, '/tmp/project');
            expect(loaded).toHaveLength(1);
            expect(loaded[0].claudeSessionId).toBe('new-id');
        });
    });

    describe('cwd filter (containment)', () => {
        it('skips sessions whose cwd is outside the agent root', () => {
            saveSession(dir, makeSession({ cwd: '/tmp/a' }));
            saveSession(dir, makeSession({ cwd: '/tmp/b' }));

            const loadedA = loadAllSessions(dir, '/tmp/a');
            expect(loadedA).toHaveLength(1);
            expect(loadedA[0].cwd).toBe('/tmp/a');
        });

        it('returns empty list when no sessions match cwd', () => {
            saveSession(dir, makeSession({ cwd: '/tmp/other' }));
            expect(loadAllSessions(dir, '/tmp/project')).toEqual([]);
        });

        it('admits sessions whose cwd is a subdirectory of the agent root', () => {
            saveSession(dir, makeSession({ id: randomUUID(), cwd: '/tmp/project' }));
            saveSession(
                dir,
                makeSession({ id: randomUUID(), cwd: '/tmp/project/packages/foo' }),
            );
            saveSession(
                dir,
                makeSession({ id: randomUUID(), cwd: '/tmp/project/packages/bar/nested' }),
            );

            const loaded = loadAllSessions(dir, '/tmp/project');
            expect(loaded).toHaveLength(3);
        });

        it('rejects a sibling path that only shares a prefix string', () => {
            // /tmp/projectile is NOT inside /tmp/project, despite sharing chars.
            saveSession(dir, makeSession({ cwd: '/tmp/projectile' }));
            expect(loadAllSessions(dir, '/tmp/project')).toEqual([]);
        });
    });

    describe('sorting', () => {
        it('returns sessions ordered by createdAt ascending', () => {
            const early = makeSession({ createdAt: 100 });
            const mid = makeSession({ createdAt: 200 });
            const late = makeSession({ createdAt: 300 });
            // Write in reverse order to confirm sort, not fs order.
            saveSession(dir, late);
            saveSession(dir, early);
            saveSession(dir, mid);

            const loaded = loadAllSessions(dir, '/tmp/project');
            expect(loaded.map((s) => s.createdAt)).toEqual([100, 200, 300]);
        });
    });

    describe('robustness', () => {
        it('returns empty list when directory does not exist', () => {
            expect(loadAllSessions(join(dir, 'missing'), '/any')).toEqual([]);
        });

        it('skips files with invalid JSON', () => {
            writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
            saveSession(dir, makeSession());
            expect(loadAllSessions(dir, '/tmp/project')).toHaveLength(1);
        });

        it('skips files with malformed schema', () => {
            writeFileSync(
                join(dir, 'bad-tool.json'),
                JSON.stringify({ id: randomUUID(), tool: 'bogus', cwd: '/tmp/project' }),
                'utf8',
            );
            writeFileSync(
                join(dir, 'bad-id.json'),
                JSON.stringify({ id: 'not-a-uuid', tool: 'claude', cwd: '/tmp/project' }),
                'utf8',
            );
            saveSession(dir, makeSession());

            const loaded = loadAllSessions(dir, '/tmp/project');
            expect(loaded).toHaveLength(1);
        });

        it('ignores non-.json files in the directory', () => {
            writeFileSync(join(dir, 'README.txt'), 'hello', 'utf8');
            saveSession(dir, makeSession());
            expect(loadAllSessions(dir, '/tmp/project')).toHaveLength(1);
        });
    });

    describe('removeSession', () => {
        it('deletes the file for a given session id', () => {
            const s = makeSession();
            saveSession(dir, s);
            expect(readdirSync(dir)).toContain(`${s.id}.json`);

            removeSession(dir, s.id);
            expect(readdirSync(dir)).not.toContain(`${s.id}.json`);
        });

        it('is a no-op when the file does not exist', () => {
            expect(() => removeSession(dir, randomUUID())).not.toThrow();
        });
    });
});

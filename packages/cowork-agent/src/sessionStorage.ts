/**
 * Per-session persistence layer.
 *
 * Layout: `<sessionsDir>/<chatSessionId>.json`, one file per chat session.
 * Each file carries enough metadata to rebuild a SessionManager entry on next
 * start — including the CLI-specific resume hints (`claudeSessionId` for
 * `claude --resume` and `geminiSessionId` for ACP `session/load`).
 *
 * Intentionally DOES NOT persist the event stream (that lives in the in-memory
 * SessionStore circular buffer). We only restore the pairing between chat
 * session id and the underlying CLI conversation.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isInsideRoot } from './fsBrowser.js';
import { logger } from './logger.js';
import type { Tool } from './sessionManager.js';

export interface PersistedSession {
    id: string;
    tool: Tool;
    model: string | undefined;
    cwd: string;
    createdAt: number;
    agentArgs: string[];
    /** Claude `--resume` id, set once the CLI first emits a session_id event. */
    claudeSessionId: string | null;
    /** Gemini ACP sessionId, passed back via `session/load` on next spawn. */
    geminiSessionId: string | null;
}

const ID_PATTERN = /^[0-9a-f-]{36}$/i;

function fileFor(dir: string, sessionId: string): string {
    return join(dir, `${sessionId}.json`);
}

function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function coerceSession(raw: unknown, filename: string): PersistedSession | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const id = o.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        logger.debug('[sessionStorage] skip', filename, 'bad id');
        return null;
    }
    const tool = o.tool;
    if (tool !== 'claude' && tool !== 'gemini') {
        logger.debug('[sessionStorage] skip', filename, 'bad tool');
        return null;
    }
    const cwd = o.cwd;
    if (typeof cwd !== 'string') {
        logger.debug('[sessionStorage] skip', filename, 'missing cwd');
        return null;
    }
    const agentArgs = Array.isArray(o.agentArgs)
        ? o.agentArgs.filter((x): x is string => typeof x === 'string')
        : [];
    return {
        id,
        tool,
        model: typeof o.model === 'string' ? o.model : undefined,
        cwd,
        createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
        agentArgs,
        claudeSessionId: typeof o.claudeSessionId === 'string' ? o.claudeSessionId : null,
        geminiSessionId: typeof o.geminiSessionId === 'string' ? o.geminiSessionId : null,
    };
}

/**
 * Load every valid session file under `dir` whose `cwd` sits inside (or
 * equals) `agentRoot`.
 *
 * Files belonging to other working directories are left untouched — a single
 * `~/.cowork-agent/sessions` folder can host sessions from multiple repos,
 * and each `cowork-agent` launch only restores its own. Sessions with a cwd
 * inside the current agent root are admitted even if that cwd is a
 * subdirectory (which is how per-session cwds land here). Results are sorted
 * by `createdAt` so the rehydrated order is stable across restarts.
 */
export function loadAllSessions(dir: string, agentRoot: string): PersistedSession[] {
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
        entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (err) {
        logger.debug('[sessionStorage] readdir failed:', (err as Error).message);
        return [];
    }
    const safeReal = (p: string): string => {
        try {
            return realpathSync(p);
        } catch {
            return p;
        }
    };
    const rootReal = safeReal(agentRoot);
    const out: PersistedSession[] = [];
    for (const file of entries) {
        const full = join(dir, file);
        try {
            const parsed: unknown = JSON.parse(readFileSync(full, 'utf8'));
            const session = coerceSession(parsed, file);
            if (!session) continue;
            if (!isInsideRoot(rootReal, safeReal(session.cwd))) continue;
            out.push(session);
        } catch (err) {
            logger.debug('[sessionStorage] parse', file, 'failed:', (err as Error).message);
        }
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
}

/** Atomic-ish write: JSON + fsync is overkill for this data, but the directory
 *  must exist. Overwrites the previous file for the same session id. */
export function saveSession(dir: string, session: PersistedSession): void {
    ensureDir(dir);
    try {
        writeFileSync(fileFor(dir, session.id), JSON.stringify(session, null, 2), 'utf8');
    } catch (err) {
        logger.debug('[sessionStorage] save failed for', session.id, (err as Error).message);
    }
}

export function removeSession(dir: string, sessionId: string): void {
    try {
        rmSync(fileFor(dir, sessionId), { force: true });
    } catch (err) {
        logger.debug('[sessionStorage] remove failed for', sessionId, (err as Error).message);
    }
}

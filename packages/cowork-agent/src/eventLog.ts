/**
 * Per-session append-only event log.
 *
 * Companion to `sessionStorage.ts` (which persists session metadata only).
 * Each session's full event stream is mirrored to `<dir>/<id>.events.jsonl`
 * so a fresh agent process can restore the in-memory `SessionStore` and the
 * reconnecting webapp sees its entire conversation history — not just the
 * events that happened since the process booted.
 *
 * Format: one JSON object per line:
 *   {"seq": <number>, "t": <epoch ms>, "payload": <whatever was broadcast>}
 *
 * `t` is the wall-clock at append time and is not used for replay logic;
 * it's there so the file is human-readable forensic material. `seq` is the
 * authoritative ordering — the load path preserves it and the store adopts
 * it via `bulkRestore`.
 *
 * Writes are sync because chat throughput is tiny (a few events per second
 * at peak) and ordering matters: an async write queue would just rebuild
 * what node's event loop already gives us for free. A torn final line
 * caused by a hard crash is shrugged off by the parser — incomplete lines
 * are skipped, never throwing.
 */

import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    rmSync,
    statSync,
} from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';

export interface LoggedEvent {
    seq: number;
    payload: unknown;
}

function fileFor(dir: string, sessionId: string): string {
    return join(dir, `${sessionId}.events.jsonl`);
}

function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Synchronously append one event. Errors are logged and swallowed — we'd
 *  rather drop a single forensic line than fail the broadcast that is
 *  already on its way to the webapp.
 *
 *  Crash-recovery: if the previous writer was killed mid-line, the file
 *  ends without a newline. Without intervention, our next append would
 *  fuse onto that torn fragment, poisoning both lines. Cheap fix: peek
 *  at the final byte and prepend a newline if missing. The torn line
 *  remains unparseable (gets skipped by the loader), but everything
 *  afterwards lands cleanly on its own row. */
function lastByteIsNewline(path: string): boolean {
    try {
        const size = statSync(path).size;
        if (size === 0) return true;
        const fd = openSync(path, 'r');
        try {
            const buf = Buffer.alloc(1);
            readSync(fd, buf, 0, 1, size - 1);
            return buf[0] === 0x0a;
        } finally {
            closeSync(fd);
        }
    } catch {
        return true;
    }
}

export function appendEvent(
    dir: string,
    sessionId: string,
    seq: number,
    payload: unknown,
): void {
    try {
        ensureDir(dir);
        const path = fileFor(dir, sessionId);
        let line = JSON.stringify({ seq, t: Date.now(), payload }) + '\n';
        if (existsSync(path) && !lastByteIsNewline(path)) line = '\n' + line;
        appendFileSync(path, line, 'utf8');
    } catch (err) {
        logger.debug(
            '[eventLog] append failed for',
            sessionId,
            '@seq',
            seq,
            (err as Error).message,
        );
    }
}

/** Read the entire log for one session, in original write order. Skips any
 *  malformed lines (e.g. a torn last line from a crash) instead of throwing,
 *  so a corrupt tail never bricks the whole session. */
export function loadEvents(dir: string, sessionId: string): LoggedEvent[] {
    const path = fileFor(dir, sessionId);
    if (!existsSync(path)) return [];
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (err) {
        logger.debug('[eventLog] read failed for', sessionId, (err as Error).message);
        return [];
    }
    const out: LoggedEvent[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            const seq = obj.seq;
            if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
            out.push({ seq, payload: obj.payload });
        } catch {
            // A torn final line is the common case; quietly skip rather than
            // logging on every restart. Deeper corruption would manifest as
            // many skipped lines, which the store's monotonic-seq check
            // would then surface.
        }
    }
    return out;
}

/** Remove the events file. Called when a session is closed (the metadata
 *  file's removal is handled separately by sessionStorage). Idempotent. */
export function removeEventLog(dir: string, sessionId: string): void {
    try {
        rmSync(fileFor(dir, sessionId), { force: true });
    } catch (err) {
        logger.debug('[eventLog] remove failed for', sessionId, (err as Error).message);
    }
}

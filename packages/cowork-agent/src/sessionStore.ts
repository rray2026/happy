export interface SessionEntry {
    seq: number;
    payload: unknown;
}

/**
 * In-memory circular buffer of the most recent `maxSize` agent messages.
 * A reconnecting webapp can request a delta from a known seq to catch up.
 */
export class SessionStore {
    private readonly entries: SessionEntry[] = [];
    /** Soft cap on resident events. Not readonly: `bulkRestore` lifts it to
     *  cover the full restored history, so a long-running session that was
     *  rehydrated from disk doesn't immediately start trimming as new events
     *  arrive. New sessions stay at the constructor-provided default. */
    private maxSize: number;
    private nextSeq = 0;

    constructor(maxSize = 200) {
        this.maxSize = maxSize;
    }

    append(payload: unknown): number {
        const seq = this.nextSeq++;
        this.entries.push({ seq, payload });
        if (this.entries.length > this.maxSize) this.entries.shift();
        return seq;
    }

    getDelta(fromSeq: number): SessionEntry[] {
        return this.entries.filter((e) => e.seq > fromSeq);
    }

    getCurrentSeq(): number {
        return this.nextSeq - 1;
    }

    getOldestSeq(): number {
        return this.entries.length > 0 ? this.entries[0].seq : -1;
    }

    /**
     * Bump `nextSeq` to start emitting at `clientSeq + 1`. Called on handshake
     * to bridge the agent-restart case: the in-memory buffer is empty but a
     * reconnecting client carries a non-zero seq watermark from before the
     * restart. Letting the client's seq view continue monotonically avoids
     * a fresh seq=0 stream getting silently dropped by the client's dedup.
     *
     * Strictly limited to "store is at its initial value" — if we already
     * have any of our own events (nextSeq > 0), the client's view and ours
     * have actually diverged, and trusting the client over ourselves would
     * be unsound. Stay put.
     */
    alignTo(clientSeq: number): void {
        if (clientSeq < 0) return;
        if (this.nextSeq !== 0) return;
        this.nextSeq = clientSeq + 1;
    }

    /**
     * Initialize from a saved event log on agent startup. Adopts the saved
     * seqs verbatim (rather than re-numbering via `append`) so reconnecting
     * clients can resume from their existing watermark without seeing the
     * whole history replayed.
     *
     * The buffer cap still applies: only the last `maxSize` events stay
     * resident; the rest live on disk for forensic purposes. `nextSeq`
     * advances to `max(seq) + 1` so future appends continue the sequence
     * monotonically. Only valid on a fresh store (nextSeq === 0).
     */
    bulkRestore(events: ReadonlyArray<{ seq: number; payload: unknown }>): void {
        if (this.nextSeq !== 0) return;
        if (events.length === 0) return;
        // Lift the cap to fit the full history. Without this, a long session
        // would lose anything beyond its tail-of-`maxSize` on restart, and
        // a reconnecting client with a low `lastSeq` would find a permanent
        // gap that the per-session circular buffer can never refill.
        this.maxSize = Math.max(this.maxSize, events.length);
        let maxSeq = -1;
        for (const e of events) {
            this.entries.push({ seq: e.seq, payload: e.payload });
            if (e.seq > maxSeq) maxSeq = e.seq;
        }
        this.nextSeq = maxSeq + 1;
    }
}

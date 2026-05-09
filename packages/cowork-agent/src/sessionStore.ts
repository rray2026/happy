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
    private readonly maxSize: number;
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
}

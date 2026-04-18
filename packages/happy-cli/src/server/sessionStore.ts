export interface SessionEntry {
    seq: number;
    payload: unknown;
}

/**
 * In-memory circular buffer that keeps the last `maxSize` agent messages.
 * Once full, oldest entries are evicted. Thread-safe for single-process use.
 */
export class SessionStore {
    private readonly entries: SessionEntry[] = [];
    private readonly maxSize: number;
    private nextSeq = 0;

    constructor(maxSize = 200) {
        this.maxSize = maxSize;
    }

    /** Append a new message and return its assigned seq number */
    append(payload: unknown): number {
        const seq = this.nextSeq++;
        this.entries.push({ seq, payload });
        if (this.entries.length > this.maxSize) {
            this.entries.shift();
        }
        return seq;
    }

    /**
     * Return all entries with seq > fromSeq.
     * If fromSeq is older than the oldest stored entry, returns all stored entries
     * (gap is silently dropped, per design decision).
     */
    getDelta(fromSeq: number): SessionEntry[] {
        return this.entries.filter(e => e.seq > fromSeq);
    }

    /** Seq number of the most recently appended entry, or -1 if empty */
    getCurrentSeq(): number {
        return this.nextSeq - 1;
    }

    /** Seq number of the oldest stored entry, or -1 if empty */
    getOldestSeq(): number {
        return this.entries.length > 0 ? this.entries[0].seq : -1;
    }
}

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
}

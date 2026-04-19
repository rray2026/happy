export class InvalidateSync {
    private pending = false;
    private running = false;
    private readonly fn: () => Promise<void>;

    constructor(fn: () => Promise<void>) {
        this.fn = fn;
    }

    invalidate() {
        if (this.running) {
            this.pending = true;
            return;
        }
        this.run();
    }

    private run() {
        this.running = true;
        this.pending = false;
        this.fn().finally(() => {
            this.running = false;
            if (this.pending) {
                this.run();
            }
        });
    }
}

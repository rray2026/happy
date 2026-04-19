export class HappyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HappyError';
    }
}

import { randomBytes } from 'node:crypto';

export function encodeBase64(buffer: Uint8Array): string {
    return Buffer.from(buffer).toString('base64');
}

export function decodeBase64(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function getRandomBytes(size: number): Uint8Array {
    return new Uint8Array(randomBytes(size));
}

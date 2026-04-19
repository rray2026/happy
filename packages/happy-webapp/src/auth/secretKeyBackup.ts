import { encodeBase64, decodeBase64 } from '@/encryption/base64';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function bytesToBase32(bytes: Uint8Array): string {
    let result = '';
    let buffer = 0;
    let bufferLength = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;
        while (bufferLength >= 5) {
            bufferLength -= 5;
            result += BASE32_ALPHABET[(buffer >> bufferLength) & 0x1f];
        }
    }
    if (bufferLength > 0) result += BASE32_ALPHABET[(buffer << (5 - bufferLength)) & 0x1f];
    return result;
}

function base32ToBytes(base32: string): Uint8Array {
    const cleaned = base32.toUpperCase()
        .replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/9/g, 'G')
        .replace(/[^A-Z2-7]/g, '');
    if (cleaned.length === 0) throw new Error('No valid characters found');
    const bytes: number[] = [];
    let buffer = 0;
    let bufferLength = 0;
    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) throw new Error('Invalid base32 character');
        buffer = (buffer << 5) | value;
        bufferLength += 5;
        if (bufferLength >= 8) {
            bufferLength -= 8;
            bytes.push((buffer >> bufferLength) & 0xff);
        }
    }
    return new Uint8Array(bytes);
}

export function formatSecretKeyForBackup(secretKey: string): string {
    const bytes = decodeBase64(secretKey, 'base64url');
    const base32 = bytesToBase32(bytes);
    const groups: string[] = [];
    for (let i = 0; i < base32.length; i += 5) groups.push(base32.slice(i, i + 5));
    return groups.join('-');
}

export function parseBackupSecretKey(formattedKey: string): string {
    const bytes = base32ToBytes(formattedKey);
    if (bytes.length !== 32) throw new Error(`Invalid key length: expected 32 bytes, got ${bytes.length}`);
    return encodeBase64(bytes, 'base64url');
}

export function isValidSecretKey(key: string): boolean {
    try {
        const parsed = key.includes('-') ? parseBackupSecretKey(key) : key;
        return decodeBase64(parsed, 'base64url').length === 32;
    } catch {
        return false;
    }
}

export function normalizeSecretKey(key: string): string {
    const trimmed = key.trim();
    if (/[-\s]/.test(trimmed) || trimmed.length > 50) return parseBackupSecretKey(trimmed);
    try {
        const bytes = decodeBase64(trimmed, 'base64url');
        if (bytes.length !== 32) throw new Error('Invalid secret key');
        return trimmed;
    } catch {
        return parseBackupSecretKey(trimmed);
    }
}

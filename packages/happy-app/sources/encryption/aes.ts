import { decodeUTF8, encodeUTF8 } from './text';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

const IV_LENGTH = 12;

async function importKey(key64: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', decodeBase64(key64) as Uint8Array<ArrayBuffer>, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    const key = await importKey(key64);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, key, new TextEncoder().encode(data) as Uint8Array<ArrayBuffer>);
    const result = new Uint8Array(IV_LENGTH + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), IV_LENGTH);
    return encodeBase64(result);
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    try {
        const key = await importKey(key64);
        const bytes = decodeBase64(data.trim());
        const iv = bytes.slice(0, IV_LENGTH);
        const ciphertext = bytes.slice(IV_LENGTH);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, key, ciphertext as Uint8Array<ArrayBuffer>);
        return new TextDecoder().decode(decrypted);
    } catch {
        return null;
    }
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    const encrypted = await encryptAESGCMString(decodeUTF8(data), key64);
    return decodeBase64(encrypted);
}

export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    const raw = await decryptAESGCMString(encodeBase64(data), key64);
    return raw ? encodeUTF8(raw) : null;
}

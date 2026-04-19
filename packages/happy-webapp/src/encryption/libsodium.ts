import sodium from 'libsodium-wrappers';

export default sodium;

function randomBytes(size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    return bytes;
}

export function getPublicKeyForBox(secretKey: Uint8Array): Uint8Array {
    return sodium.crypto_box_seed_keypair(secretKey).publicKey;
}

export function encryptBox(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = sodium.crypto_box_keypair();
    const nonce = randomBytes(sodium.crypto_box_NONCEBYTES);
    const encrypted = sodium.crypto_box_easy(data, nonce, recipientPublicKey, ephemeralKeyPair.privateKey);
    const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, ephemeralKeyPair.publicKey.length);
    result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
    return result;
}

export function decryptBox(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    const ephemeralPublicKey = encryptedBundle.slice(0, sodium.crypto_box_PUBLICKEYBYTES);
    const nonce = encryptedBundle.slice(sodium.crypto_box_PUBLICKEYBYTES, sodium.crypto_box_PUBLICKEYBYTES + sodium.crypto_box_NONCEBYTES);
    const encrypted = encryptedBundle.slice(sodium.crypto_box_PUBLICKEYBYTES + sodium.crypto_box_NONCEBYTES);
    try {
        return sodium.crypto_box_open_easy(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    } catch {
        return null;
    }
}

export function encryptSecretBox(data: unknown, secret: Uint8Array): Uint8Array {
    const nonce = randomBytes(sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = sodium.crypto_secretbox_easy(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

export function decryptSecretBox(data: Uint8Array, secret: Uint8Array): unknown {
    const nonce = data.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = data.slice(sodium.crypto_secretbox_NONCEBYTES);
    try {
        const decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonce, secret);
        if (!decrypted) return null;
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

import sodium from '@/encryption/libsodium';

export function authChallenge(secret: Uint8Array) {
    const keypair = sodium.crypto_sign_seed_keypair(secret);
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const signature = sodium.crypto_sign_detached(challenge, keypair.privateKey);
    return { challenge, signature, publicKey: keypair.publicKey };
}

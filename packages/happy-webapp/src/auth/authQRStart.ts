import sodium from '@/encryption/libsodium';
import axios from 'axios';
import { encodeBase64 } from '@/encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getServerUrl();
        await axios.post(`${serverUrl}/v1/auth/account/request`, {
            publicKey: encodeBase64(keypair.publicKey),
        });
        return true;
    } catch {
        console.error('Failed to create authentication request');
        return false;
    }
}

import { authChallenge } from './authChallenge';
import axios from 'axios';
import { encodeBase64 } from '@/encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';

export async function authGetToken(secret: Uint8Array): Promise<string> {
    const serverUrl = getServerUrl();
    const { challenge, signature, publicKey } = authChallenge(secret);
    const response = await axios.post(`${serverUrl}/v1/auth`, {
        challenge: encodeBase64(challenge),
        signature: encodeBase64(signature),
        publicKey: encodeBase64(publicKey),
    });
    return response.data.token;
}

// Stub — push notification registration removed.
import type { AuthCredentials } from '@/auth/tokenStorage';

export async function syncCurrentPushToken(_credentials: AuthCredentials): Promise<void> {}
export async function registerPushToken(_credentials: AuthCredentials, _token: string): Promise<void> {}
export async function unregisterPushToken(_credentials: AuthCredentials, _token: string): Promise<void> {}

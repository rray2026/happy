// Stub — friends API removed.
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { UserProfile } from './friendTypes';

export async function getFriendsList(_credentials: AuthCredentials): Promise<UserProfile[]> {
    return [];
}

export async function getUserProfile(_credentials: AuthCredentials, _userId: string): Promise<UserProfile | null> {
    return null;
}

// Stub — feed API removed.
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { FeedItem } from './feedTypes';

export async function fetchFeed(_credentials: AuthCredentials): Promise<FeedItem[]> {
    return [];
}

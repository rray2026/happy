// Stub — social features removed.

export interface UserProfile {
    id: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    avatar?: { thumbhash?: string } | null;
    status: 'friend' | 'pending' | 'requested' | 'none';
}

export interface RelationshipUpdatedEvent {
    fromUserId: string;
    toUserId: string;
    status: 'friend' | 'pending' | 'requested' | 'none';
    action?: string;
    fromUser?: UserProfile;
    toUser?: UserProfile;
}

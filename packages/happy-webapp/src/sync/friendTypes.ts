import * as z from 'zod';
import { ImageRefSchema } from './profile';

export const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
export type RelationshipStatus = z.infer<typeof RelationshipStatusSchema>;

export const UserProfileSchema = z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
        path: z.string(),
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        thumbhash: z.string().optional(),
    }).nullable(),
    username: z.string(),
    bio: z.string().nullable(),
    status: RelationshipStatusSchema,
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export function getDisplayName(profile: UserProfile): string {
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    return fullName || profile.username;
}

export function isFriend(status: RelationshipStatus): boolean { return status === 'friend'; }
export function isPendingRequest(status: RelationshipStatus): boolean { return status === 'pending'; }
export function isRequested(status: RelationshipStatus): boolean { return status === 'requested'; }

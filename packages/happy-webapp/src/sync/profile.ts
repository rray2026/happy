import * as z from 'zod';

export const GitHubProfileSchema = z.object({
    id: z.number(),
    login: z.string(),
    name: z.string(),
    avatar_url: z.string(),
    email: z.string().optional(),
    bio: z.string().nullable(),
});

export const ImageRefSchema = z.object({
    width: z.number(),
    height: z.number(),
    thumbhash: z.string(),
    path: z.string(),
    url: z.string(),
});

export const ProfileSchema = z.object({
    id: z.string(),
    timestamp: z.number(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    avatar: ImageRefSchema.nullable(),
    github: GitHubProfileSchema.nullable(),
    connectedServices: z.array(z.string()).default([]),
});

export type GitHubProfile = z.infer<typeof GitHubProfileSchema>;
export type ImageRef = z.infer<typeof ImageRefSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

export const profileDefaults: Profile = {
    id: '', timestamp: 0, firstName: null, lastName: null,
    avatar: null, github: null, connectedServices: [],
};
Object.freeze(profileDefaults);

export function profileParse(profile: unknown): Profile {
    const parsed = ProfileSchema.safeParse(profile);
    return parsed.success ? parsed.data : { ...profileDefaults };
}

export function getDisplayName(profile: Profile): string | null {
    if (profile.firstName || profile.lastName) {
        return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    }
    return profile.github?.name ?? profile.github?.login ?? null;
}

export function getAvatarUrl(profile: Profile): string | null {
    return profile.avatar?.url ?? profile.github?.avatar_url ?? null;
}

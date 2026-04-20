// Stub — server-side user profile removed.

export interface Profile {
    id: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    bio?: string;
    avatar?: { thumbhash?: string; url?: string } | null;
    github?: { login: string } | null;
}

export const profileDefaults: Profile = {
    id: '',
};

export function profileParse(raw: unknown): Profile {
    if (!raw || typeof raw !== 'object') return { ...profileDefaults };
    const r = raw as Record<string, unknown>;
    return {
        id: typeof r.id === 'string' ? r.id : '',
        firstName: typeof r.firstName === 'string' ? r.firstName : undefined,
        lastName: typeof r.lastName === 'string' ? r.lastName : undefined,
        username: typeof r.username === 'string' ? r.username : undefined,
        bio: typeof r.bio === 'string' ? r.bio : undefined,
        avatar: r.avatar as Profile['avatar'] ?? null,
        github: r.github as Profile['github'] ?? null,
    };
}

export function getDisplayName(profile: Profile): string {
    if (profile.firstName || profile.lastName) {
        return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    }
    return profile.username ?? profile.id ?? '';
}

export function getAvatarUrl(profile: Profile): string | null {
    return profile.avatar?.url ?? null;
}

export function getBio(profile: Profile): string | null {
    return profile.bio ?? null;
}

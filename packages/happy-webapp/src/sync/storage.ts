import { create } from 'zustand';
import { Session, Machine } from './storageTypes';
import { Settings, settingsDefaults } from './settings';
import { LocalSettings, localSettingsDefaults } from './localSettings';
import { Profile, profileDefaults } from './profile';
import { UserProfile } from './friendTypes';
import { DecryptedArtifact } from './artifactTypes';
import { FeedItem } from './feedTypes';
import { getSessionName, getSessionAvatarId, getSessionSubtitle, getSessionState, SessionState } from '@/utils/sessionUtils';

// Row data for session list — all primitives for efficient re-render comparison
export interface SessionRowData {
    id: string;
    name: string;
    subtitle: string;
    avatarId: string;
    flavor: string | null;
    state: SessionState;
    activeAt?: number;
    createdAt?: number;
    hasDraft: boolean;
    active: boolean;
    machineId: string | null;
    path: string | null;
    homeDir: string | null;
    completedTodosCount: number;
    totalTodosCount: number;
}

function buildSessionRowData(session: Session): SessionRowData {
    const state = getSessionState(session);
    const todos = session.todos ?? [];
    return {
        id: session.id,
        name: getSessionName(session),
        subtitle: getSessionSubtitle(session),
        avatarId: getSessionAvatarId(session),
        flavor: session.metadata?.flavor ?? null,
        state,
        ...(!session.active && { activeAt: session.activeAt, createdAt: session.createdAt }),
        hasDraft: !!session.draft,
        active: session.active,
        machineId: session.metadata?.machineId ?? null,
        path: session.metadata?.path ?? null,
        homeDir: session.metadata?.homeDir ?? null,
        completedTodosCount: todos.filter(t => t.status === 'completed').length,
        totalTodosCount: todos.length,
    };
}

interface SessionMessages {
    messages: unknown[];
    isLoaded: boolean;
}

interface StorageState {
    // Auth
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';

    // Sessions
    sessions: Record<string, Session>;
    sessionRows: SessionRowData[];
    sessionMessages: Record<string, SessionMessages>;
    visibleSessionId: string | null;

    // Machines
    machines: Record<string, Machine>;

    // Settings
    settings: Settings;
    localSettings: LocalSettings;

    // Profile & social
    profile: Profile;
    friends: UserProfile[];

    // Artifacts
    artifacts: DecryptedArtifact[];

    // Feed / inbox
    feedItems: FeedItem[];
    feedUnreadCount: number;

    // Actions
    setConnectionStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setSession: (session: Session) => void;
    setSessions: (sessions: Session[]) => void;
    deleteSession: (id: string) => void;
    setMachine: (machine: Machine) => void;
    setMachines: (machines: Machine[]) => void;
    setSessionMessages: (sessionId: string, messages: unknown[], isLoaded: boolean) => void;
    setVisibleSessionId: (id: string | null) => void;
    setSettings: (settings: Settings) => void;
    setLocalSettings: (settings: LocalSettings) => void;
    setProfile: (profile: Profile) => void;
    setFriends: (friends: UserProfile[]) => void;
    setArtifacts: (artifacts: DecryptedArtifact[]) => void;
    setFeedItems: (items: FeedItem[], unreadCount: number) => void;
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
}

export const storage = create<StorageState>((set, get) => ({
    connectionStatus: 'disconnected',

    sessions: {},
    sessionRows: [],
    sessionMessages: {},
    visibleSessionId: null,

    machines: {},

    settings: { ...settingsDefaults },
    localSettings: { ...localSettingsDefaults },

    profile: { ...profileDefaults },
    friends: [],

    artifacts: [],

    feedItems: [],
    feedUnreadCount: 0,

    setConnectionStatus: (status) => set({ connectionStatus: status }),

    setSession: (session) => set((state) => {
        const sessions = { ...state.sessions, [session.id]: session };
        const sessionRows = Object.values(sessions)
            .sort((a, b) => {
                if (a.active !== b.active) return a.active ? -1 : 1;
                return b.updatedAt - a.updatedAt;
            })
            .map(buildSessionRowData);
        return { sessions, sessionRows };
    }),

    setSessions: (newSessions) => set(() => {
        const sessions: Record<string, Session> = {};
        for (const s of newSessions) sessions[s.id] = s;
        const sessionRows = newSessions
            .sort((a, b) => {
                if (a.active !== b.active) return a.active ? -1 : 1;
                return b.updatedAt - a.updatedAt;
            })
            .map(buildSessionRowData);
        return { sessions, sessionRows };
    }),

    deleteSession: (id) => set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[id];
        const sessionRows = Object.values(sessions)
            .sort((a, b) => {
                if (a.active !== b.active) return a.active ? -1 : 1;
                return b.updatedAt - a.updatedAt;
            })
            .map(buildSessionRowData);
        return { sessions, sessionRows };
    }),

    setMachine: (machine) => set((state) => ({
        machines: { ...state.machines, [machine.id]: machine },
    })),

    setMachines: (newMachines) => set(() => {
        const machines: Record<string, Machine> = {};
        for (const m of newMachines) machines[m.id] = m;
        return { machines };
    }),

    setSessionMessages: (sessionId, messages, isLoaded) => set((state) => ({
        sessionMessages: {
            ...state.sessionMessages,
            [sessionId]: { messages, isLoaded },
        },
    })),

    setVisibleSessionId: (id) => set({ visibleSessionId: id }),

    setSettings: (settings) => set({ settings }),

    setLocalSettings: (localSettings) => set({ localSettings }),

    setProfile: (profile) => set({ profile }),

    setFriends: (friends) => set({ friends }),

    setArtifacts: (artifacts) => set({ artifacts }),

    setFeedItems: (feedItems, feedUnreadCount) => set({ feedItems, feedUnreadCount }),

    updateSessionDraft: (sessionId, draft) => set((state) => {
        const session = state.sessions[sessionId];
        if (!session) return {};
        const updated = { ...session, draft };
        const sessions = { ...state.sessions, [sessionId]: updated };
        const sessionRows = state.sessionRows.map(r =>
            r.id === sessionId ? { ...r, hasDraft: !!draft } : r
        );
        return { sessions, sessionRows };
    }),
}));

// Selector hooks
export function useSession(id: string): Session | undefined {
    return storage(state => state.sessions[id]);
}

export function useSessionMessages(id: string): SessionMessages | undefined {
    return storage(state => state.sessionMessages[id]);
}

export function useSessionRows(): SessionRowData[] {
    return storage(state => state.sessionRows);
}

export function useMachine(id: string): Machine | undefined {
    return storage(state => state.machines[id]);
}

export function useMachines(): Machine[] {
    return storage(state => Object.values(state.machines));
}

export function useSettings(): Settings {
    return storage(state => state.settings);
}

export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
    return storage(state => state.settings[key]);
}

export function useLocalSettings(): LocalSettings {
    return storage(state => state.localSettings);
}

export function useLocalSetting<K extends keyof LocalSettings>(key: K): LocalSettings[K] {
    return storage(state => state.localSettings[key]);
}

export function useProfile(): Profile {
    return storage(state => state.profile);
}

export function useFriends(): UserProfile[] {
    return storage(state => state.friends);
}

export function useArtifacts(): DecryptedArtifact[] {
    return storage(state => state.artifacts);
}

export function useFeedItems(): FeedItem[] {
    return storage(state => state.feedItems);
}

export function useConnectionStatus() {
    return storage(state => state.connectionStatus);
}

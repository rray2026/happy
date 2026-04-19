import { AuthCredentials } from '@/auth/tokenStorage';
import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { getServerUrl } from './serverConfig';
import { Session, Machine } from './storageTypes';
import { Settings, settingsParse, applySettings } from './settings';
import { Profile, profileParse } from './profile';
import { UserProfile } from './friendTypes';
import { DecryptedArtifact } from './artifactTypes';
import { FeedItem, FeedItemSchema } from './feedTypes';
import { InvalidateSync } from '@/utils/invalidateSync';
import { loadSettings, saveSettings, loadLocalSettings, saveLocalSettings, loadSessionDrafts, saveSessionDrafts } from './persistence';

class Sync {
    private credentials: AuthCredentials | null = null;
    private sessionsSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private friendsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private pendingSettings: Partial<Settings> = {};
    private sessionMessageSyncs = new Map<string, InvalidateSync>();

    constructor() {
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.artifactsSync = new InvalidateSync(this.fetchArtifacts);
        this.friendsSync = new InvalidateSync(this.fetchFriends);
        this.feedSync = new InvalidateSync(this.fetchFeed);
    }

    async create(credentials: AuthCredentials) {
        this.credentials = credentials;
        this.init();
    }

    async restore(credentials: AuthCredentials) {
        this.credentials = credentials;

        // Restore persisted settings and drafts immediately
        const { settings } = loadSettings();
        const localSettings = loadLocalSettings();
        const drafts = loadSessionDrafts();
        storage.getState().setSettings(settings);
        storage.getState().setLocalSettings(localSettings);

        this.init();
    }

    private init() {
        if (!this.credentials) return;

        apiSocket.initialize({
            endpoint: getServerUrl(),
            token: this.credentials.token,
        });

        apiSocket.onStatusChange(status => {
            storage.getState().setConnectionStatus(status);
        });

        apiSocket.onReconnected(() => {
            this.sessionsSync.invalidate();
            this.machinesSync.invalidate();
            this.settingsSync.invalidate();
            this.profileSync.invalidate();
            this.artifactsSync.invalidate();
            this.friendsSync.invalidate();
            this.feedSync.invalidate();
        });

        // Server-push events
        apiSocket.onMessage('session-updated', () => this.sessionsSync.invalidate());
        apiSocket.onMessage('machine-updated', () => this.machinesSync.invalidate());
        apiSocket.onMessage('settings-updated', () => this.settingsSync.invalidate());
        apiSocket.onMessage('profile-updated', () => this.profileSync.invalidate());
        apiSocket.onMessage('artifact-updated', () => this.artifactsSync.invalidate());
        apiSocket.onMessage('relationship-updated', () => this.friendsSync.invalidate());
        apiSocket.onMessage('feed-updated', () => this.feedSync.invalidate());

        apiSocket.onMessage('session-message', (data: unknown) => {
            const msg = data as { sessionId: string };
            if (msg?.sessionId) {
                const sessionId = msg.sessionId;
                this.getMessageSync(sessionId).invalidate();
            }
        });

        this.sessionsSync.invalidate();
        this.machinesSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.artifactsSync.invalidate();
        this.friendsSync.invalidate();
        this.feedSync.invalidate();
    }

    destroy() {
        apiSocket.disconnect();
        this.credentials = null;
    }

    onSessionVisible(sessionId: string) {
        this.getMessageSync(sessionId).invalidate();
    }

    private getMessageSync(sessionId: string): InvalidateSync {
        if (!this.sessionMessageSyncs.has(sessionId)) {
            this.sessionMessageSyncs.set(sessionId, new InvalidateSync(() => this.fetchMessages(sessionId)));
        }
        return this.sessionMessageSyncs.get(sessionId)!;
    }

    private authedFetch(path: string, init?: RequestInit): Promise<Response> {
        if (!this.credentials) throw new Error('Not authenticated');
        return fetch(`${getServerUrl()}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                ...init?.headers,
            },
        });
    }

    private fetchSessions = async () => {
        const res = await this.authedFetch('/v1/sessions');
        if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
        const data = await res.json();
        const sessions: Session[] = (data.sessions ?? []).map((s: unknown) => this.rawToSession(s));
        storage.getState().setSessions(sessions);
    };

    private rawToSession(raw: unknown): Session {
        const s = raw as Record<string, unknown>;
        return {
            id: s.id as string,
            seq: s.seq as number ?? 0,
            createdAt: s.createdAt as number ?? Date.now(),
            updatedAt: s.updatedAt as number ?? Date.now(),
            active: s.active as boolean ?? false,
            activeAt: s.activeAt as number ?? 0,
            metadata: this.tryParseJson(s.metadata as string | null) as Session['metadata'],
            metadataVersion: s.metadataVersion as number ?? 0,
            agentState: this.tryParseJson(s.agentState as string | null) as Session['agentState'],
            agentStateVersion: s.agentStateVersion as number ?? 0,
            thinking: false,
            thinkingAt: 0,
            presence: (s.active ? 'online' : (s.activeAt as number ?? 0)) as 'online' | number,
            latestUsage: null,
        };
    }

    private tryParseJson(val: string | null | undefined): unknown {
        if (!val) return null;
        try { return JSON.parse(val); } catch { return null; }
    }

    private fetchMachines = async () => {
        const res = await this.authedFetch('/v1/machines');
        if (!res.ok) throw new Error(`Failed to fetch machines: ${res.status}`);
        const data = await res.json();
        const machines: Machine[] = (data.machines ?? []).map((m: unknown) => {
            const raw = m as Record<string, unknown>;
            return {
                id: raw.id as string,
                seq: raw.seq as number ?? 0,
                createdAt: raw.createdAt as number ?? Date.now(),
                updatedAt: raw.updatedAt as number ?? Date.now(),
                active: raw.active as boolean ?? false,
                activeAt: raw.activeAt as number ?? 0,
                metadata: this.tryParseJson(raw.metadata as string | null),
                metadataVersion: raw.metadataVersion as number ?? 0,
                daemonState: this.tryParseJson(raw.daemonState as string | null),
                daemonStateVersion: raw.daemonStateVersion as number ?? 0,
            } as Machine;
        });
        storage.getState().setMachines(machines);
    };

    private fetchMessages = async (sessionId: string) => {
        const res = await this.authedFetch(`/v3/sessions/${sessionId}/messages?limit=200`);
        if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
        const data = await res.json();
        const messages = data.messages ?? [];
        storage.getState().setSessionMessages(sessionId, messages, true);
    };

    private syncSettings = async () => {
        const { settings: localSettings, version: localVersion } = loadSettings();
        if (Object.keys(this.pendingSettings).length > 0) {
            const merged = applySettings(localSettings, this.pendingSettings);
            const res = await this.authedFetch('/v1/settings', {
                method: 'POST',
                body: JSON.stringify({ settings: merged, version: localVersion ?? 0 }),
            });
            if (res.ok) {
                this.pendingSettings = {};
                const data = await res.json();
                const serverSettings = settingsParse(data.settings);
                saveSettings(serverSettings, data.version ?? 0);
                storage.getState().setSettings(serverSettings);
            }
        } else {
            const res = await this.authedFetch('/v1/settings');
            if (!res.ok) return;
            const data = await res.json();
            const serverSettings = settingsParse(data.settings);
            saveSettings(serverSettings, data.version ?? 0);
            storage.getState().setSettings(serverSettings);
        }
    };

    applySettings(delta: Partial<Settings>) {
        const current = storage.getState().settings;
        const updated = applySettings(current, delta);
        storage.getState().setSettings(updated);
        this.pendingSettings = { ...this.pendingSettings, ...delta };
        saveSettings(updated, Date.now());
        this.settingsSync.invalidate();
    }

    private fetchProfile = async () => {
        const res = await this.authedFetch('/v1/profile');
        if (!res.ok) return;
        const data = await res.json();
        const profile = profileParse(data);
        storage.getState().setProfile(profile);
    };

    private fetchArtifacts = async () => {
        const res = await this.authedFetch('/v1/artifacts');
        if (!res.ok) return;
        const data = await res.json();
        const artifacts: DecryptedArtifact[] = (data.artifacts ?? []).map((a: unknown) => {
            const raw = a as Record<string, unknown>;
            return {
                id: raw.id as string,
                title: (raw.title as string | null) ?? null,
                body: undefined,
                headerVersion: raw.headerVersion as number ?? 0,
                seq: raw.seq as number ?? 0,
                createdAt: raw.createdAt as number ?? Date.now(),
                updatedAt: raw.updatedAt as number ?? Date.now(),
                isDecrypted: true,
            } as DecryptedArtifact;
        });
        storage.getState().setArtifacts(artifacts);
    };

    private fetchFriends = async () => {
        const res = await this.authedFetch('/v1/users/friends');
        if (!res.ok) return;
        const data = await res.json();
        const friends: UserProfile[] = data.friends ?? data.users ?? [];
        storage.getState().setFriends(friends);
    };

    private fetchFeed = async () => {
        const res = await this.authedFetch('/v1/feed');
        if (!res.ok) return;
        const data = await res.json();
        const items: FeedItem[] = (data.items ?? [])
            .map((i: unknown) => FeedItemSchema.safeParse(i))
            .filter((r: { success: boolean }) => r.success)
            .map((r: { success: true; data: FeedItem }) => r.data);
        storage.getState().setFeedItems(items, data.unreadCount ?? 0);
    };

    async sendMessage(sessionId: string, text: string) {
        if (!this.credentials) return;
        const localId = crypto.randomUUID();
        const payload = {
            localId,
            content: JSON.stringify({
                role: 'user',
                content: { type: 'text', text },
                meta: { sentFrom: 'web' },
            }),
        };
        const res = await this.authedFetch(`/v3/sessions/${sessionId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ messages: [payload] }),
        });
        if (!res.ok) throw new Error(`Failed to send message: ${res.status}`);
        this.getMessageSync(sessionId).invalidate();
    }

    async deleteSession(sessionId: string) {
        if (!this.credentials) return;
        await this.authedFetch(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
        storage.getState().deleteSession(sessionId);
        this.sessionsSync.invalidate();
    }

    async createArtifact(title: string | null, body: string | null) {
        if (!this.credentials) return;
        const id = crypto.randomUUID();
        await this.authedFetch('/v1/artifacts', {
            method: 'POST',
            body: JSON.stringify({ id, title, body }),
        });
        this.artifactsSync.invalidate();
    }

    async updateArtifact(id: string, title: string | null, body: string | null) {
        if (!this.credentials) return;
        await this.authedFetch(`/v1/artifacts/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ title, body }),
        });
        this.artifactsSync.invalidate();
    }

    async deleteArtifact(id: string) {
        if (!this.credentials) return;
        await this.authedFetch(`/v1/artifacts/${id}`, { method: 'DELETE' });
        const artifacts = storage.getState().artifacts.filter(a => a.id !== id);
        storage.getState().setArtifacts(artifacts);
    }

    async addFriend(username: string) {
        if (!this.credentials) return;
        await this.authedFetch(`/v1/users/${username}/friend`, { method: 'POST' });
        this.friendsSync.invalidate();
    }

    async removeFriend(userId: string) {
        if (!this.credentials) return;
        await this.authedFetch(`/v1/users/${userId}/friend`, { method: 'DELETE' });
        this.friendsSync.invalidate();
    }

    async acceptFriendRequest(userId: string) {
        if (!this.credentials) return;
        await this.authedFetch(`/v1/users/${userId}/friend/accept`, { method: 'POST' });
        this.friendsSync.invalidate();
    }

    async searchUsers(query: string): Promise<UserProfile[]> {
        if (!this.credentials) return [];
        const res = await this.authedFetch(`/v1/users/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.users ?? [];
    }

    async updateProfile(update: { firstName?: string; username?: string }) {
        if (!this.credentials) return;
        await this.authedFetch('/v1/profile', {
            method: 'PATCH',
            body: JSON.stringify(update),
        });
        this.profileSync.invalidate();
    }

    async stopMachineDaemon(machineId: string) {
        if (!this.credentials) return;
        await apiSocket.emitWithAck('rpc-call', {
            method: `${machineId}:daemon:stop`,
            params: {},
        });
        this.machinesSync.invalidate();
    }

    async spawnSession(machineId: string, path: string) {
        if (!this.credentials) return;
        const res = await this.authedFetch('/v1/sessions', {
            method: 'POST',
            body: JSON.stringify({ machineId, path }),
        });
        if (!res.ok) throw new Error(`Failed to spawn session: ${res.status}`);
        this.sessionsSync.invalidate();
    }

    refreshSessions() { this.sessionsSync.invalidate(); }
    refreshMachines() { this.machinesSync.invalidate(); }
    refreshArtifacts() { this.artifactsSync.invalidate(); }
    refreshFriends() { this.friendsSync.invalidate(); }
    refreshFeed() { this.feedSync.invalidate(); }
}

export const sync = new Sync();

export async function syncCreate(credentials: AuthCredentials) {
    await sync.create(credentials);
}

export async function syncRestore(credentials: AuthCredentials) {
    await sync.restore(credentials);
}

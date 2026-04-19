import { Session } from '@/sync/storageTypes';

export type SessionState = 'disconnected' | 'thinking' | 'waiting' | 'permission_required';

export function getSessionName(session: Session): string {
    if (session.metadata?.summary) {
        return session.metadata.summary.text;
    } else if (session.metadata) {
        const segments = session.metadata.path.split('/').filter(Boolean);
        const lastSegment = segments.pop();
        return lastSegment ?? 'unknown';
    }
    return 'unknown';
}

export function getSessionAvatarId(session: Session): string {
    if (session.metadata?.machineId && session.metadata?.path) {
        return `${session.metadata.machineId}:${session.metadata.path}`;
    }
    return session.id;
}

export function getSessionSubtitle(session: Session): string {
    if (session.metadata) {
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }
    return 'unknown';
}

export function getSessionState(session: Session): SessionState {
    const isOnline = session.presence === 'online';
    if (!isOnline) return 'disconnected';
    const hasPermissions = !!(session.agentState?.requests && Object.keys(session.agentState.requests).length > 0);
    if (hasPermissions) return 'permission_required';
    if (session.thinking) return 'thinking';
    return 'waiting';
}

export function isSessionOnline(session: Session): boolean {
    return session.active;
}

export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    if (path.startsWith(normalizedHome)) {
        const relative = path.slice(normalizedHome.length);
        if (relative.startsWith('/')) return '~' + relative;
        if (relative === '') return '~';
        return '~/' + relative;
    }
    return path;
}

export function formatLastSeen(activeAt: number): string {
    const now = Date.now();
    const diffMs = now - activeAt;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(activeAt).toLocaleDateString();
}

export function formatOSPlatform(platform?: string): string {
    if (!platform) return '';
    const osMap: Record<string, string> = {
        darwin: 'macOS', win32: 'Windows', linux: 'Linux',
        android: 'Android', ios: 'iOS',
    };
    return osMap[platform.toLowerCase()] ?? platform;
}

import { useCallback, useSyncExternalStore } from 'react';
import { sessionClient } from '../session';
import type { ChatSessionMeta, PermissionEvent, SocketStatus } from '../types';

const subscribeStatus = (cb: () => void): (() => void) => sessionClient.onStatusChange(cb);
const getStatus = (): SocketStatus => sessionClient.getStatus();

/** Connection status, kept in sync with the session client. */
export function useStatus(): SocketStatus {
    return useSyncExternalStore(subscribeStatus, getStatus, getStatus);
}

const subscribeSessions = (cb: () => void): (() => void) => sessionClient.onSessionsChange(cb);
const getSessions = (): ChatSessionMeta[] => sessionClient.getSessions();

/** Live session list. The client only swaps the underlying array on welcome
 *  / sessions-changed frames, so the snapshot is reference-stable between
 *  emits — safe for useSyncExternalStore. */
export function useSessions(): ChatSessionMeta[] {
    return useSyncExternalStore(subscribeSessions, getSessions, getSessions);
}

/**
 * Subscribe to the per-session pending permission. Returns null when there's
 * nothing waiting. Used by SessionListPage / SessionSidebar rows to render
 * a badge when a non-active session needs the user's attention.
 */
export function usePendingPermission(sessionId: string): PermissionEvent | null {
    return useSyncExternalStore<PermissionEvent | null>(
        useCallback((cb) => sessionClient.onPermissionChange(sessionId, cb), [sessionId]),
        useCallback(() => sessionClient.getPendingPermission(sessionId), [sessionId]),
    );
}

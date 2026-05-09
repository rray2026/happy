import { useCallback, useSyncExternalStore } from 'react';
import { sessionClient } from '../session';
import type { PermissionEvent } from '../types';

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

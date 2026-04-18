// Voice/realtime feature removed — stubs keep dependent code compiling.

export const voiceHooks = {
    onSessionFocus: (_sessionId: string, _metadata?: unknown) => {},
    onPermissionRequested: (_permId: string, _reqId: string, _tool: string, _args?: unknown) => {},
    onMessages: (_sessionId: string, _messages: unknown) => {},
    onReady: (_sessionId: string) => {},
    onSessionOffline: (_sessionId: string, _metadata?: unknown) => {},
    onSessionOnline: (_sessionId: string, _metadata?: unknown) => {},
    onVoiceStarted: (_sessionId: string): string | undefined => undefined,
    onVoiceStopped: () => {},
};

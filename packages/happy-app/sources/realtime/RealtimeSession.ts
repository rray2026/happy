// Voice/realtime feature removed — stubs keep dependent code compiling.

export function getCurrentRealtimeSessionId(): string | null { return null; }
export function getVoiceSession(): null { return null; }
export function getCurrentVoiceConversationId(): string | null { return null; }
export function getCurrentVoiceSessionDurationSeconds(): number { return 0; }
export async function startRealtimeSession(_sessionId: string, _agentId?: string): Promise<string | null> { return null; }
export async function stopRealtimeSession(): Promise<void> {}

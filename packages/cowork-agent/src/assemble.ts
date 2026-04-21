import { readFileSync } from 'node:fs';
import { runClaudeProcess } from './claudeProcess.js';
import { GeminiAcpSession } from './geminiAcp.js';
import { logger } from './logger.js';
import type { WsServerHandle } from './types.js';

export type AgentType = 'claude' | 'gemini';

export interface WireOptions {
    agent: AgentType;
    server: WsServerHandle;
    model?: string;
    agentArgs?: string[];
    /** For gemini: resume an existing ACP session. Ignored for claude. */
    resumeSessionId?: string;
    /** For claude: initial session id (usually null on first turn). */
    claudeResumeSessionId?: string | null;
    /** Override the `claude` binary. Tests pass a fake script path. */
    claudeCommand?: string;
    /** Extra env for claude spawn. */
    claudeExtraEnv?: Record<string, string>;
    /** Override the `gemini` binary. Tests pass a fake script path. */
    geminiCommand?: string;
    /** Extra env for gemini spawn. */
    geminiExtraEnv?: Record<string, string>;
    geminiApiKey?: string;
    /** Called after every successful gemini turn with the active session id,
     *  so callers (e.g. `handleServe`) can persist it. */
    onGeminiSessionId?: (id: string) => void;
}

export interface WireHandle {
    handleInput(text: string): Promise<void>;
    handleRpc(id: string, method: string, params: unknown): Promise<void>;
    getClaudeSessionId(): string | null;
    dispose(): void;
}

export function wireAgentToServer(opts: WireOptions): WireHandle {
    const { agent, server } = opts;
    const abortController = new AbortController();
    const permissionPending = new Map<string, (approved: boolean) => void>();
    let claudeSessionId: string | null = opts.claudeResumeSessionId ?? null;
    let agentBusy = false;

    const geminiSession =
        agent === 'gemini'
            ? new GeminiAcpSession({
                  broadcast: (e) => server.broadcast(e),
                  apiKey: opts.geminiApiKey,
                  resumeSessionId: opts.resumeSessionId,
                  model: opts.model,
                  command: opts.geminiCommand,
                  extraEnv: opts.geminiExtraEnv,
                  onPermissionRequest: (permissionId, toolName, input) =>
                      new Promise<boolean>((resolve) => {
                          permissionPending.set(permissionId, resolve);
                          server.broadcast({
                              type: 'permission-request',
                              permissionId,
                              toolName,
                              input,
                          });
                      }),
              })
            : null;

    async function handleInput(text: string): Promise<void> {
        if (agentBusy) {
            logger.debug('[assemble] ignored input — agent busy');
            return;
        }
        agentBusy = true;
        try {
            if (agent === 'gemini' && geminiSession) {
                try {
                    await geminiSession.sendPrompt(text);
                    const gid = geminiSession.getSessionId();
                    if (gid) opts.onGeminiSessionId?.(gid);
                    server.broadcast({ type: 'result', subtype: 'success', result: 'Done' });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.debug('[assemble] gemini error:', msg);
                    server.broadcast({ type: 'result', subtype: 'error', result: msg });
                }
                return;
            }

            await runClaudeProcess({
                prompt: text,
                resumeSessionId: claudeSessionId,
                model: opts.model,
                agentArgs: opts.agentArgs ?? [],
                onEvent: (e) => server.broadcast(e),
                onSessionId: (id) => {
                    if (!claudeSessionId) {
                        claudeSessionId = id;
                        logger.debug('[assemble] claude session id:', id);
                    }
                },
                abort: abortController.signal,
                command: opts.claudeCommand,
                extraEnv: opts.claudeExtraEnv,
            });
        } finally {
            agentBusy = false;
        }
    }

    async function handleRpc(id: string, method: string, params: unknown): Promise<void> {
        if (method === 'abort') {
            abortController.abort();
            geminiSession?.dispose();
            server.sendRpcResponse(id, { ok: true });
            return;
        }
        if (method === 'permissionResponse') {
            const p = params as { permissionId: string; approved: boolean };
            const resolver = permissionPending.get(p.permissionId);
            if (resolver) {
                permissionPending.delete(p.permissionId);
                resolver(p.approved);
            }
            server.sendRpcResponse(id, { ok: true });
            return;
        }
        if (method === 'replay') {
            const raw = (params as Record<string, unknown> | undefined)?.fromSeq;
            const fromSeq = parseInt((raw as string) ?? '-1', 10);
            server.replayFrom(isNaN(fromSeq) ? -1 : fromSeq);
            server.sendRpcResponse(id, { ok: true });
            return;
        }
        if (method === 'getLogs') {
            const raw = (params as Record<string, unknown> | undefined)?.lines;
            const count = parseInt((raw as string) ?? '200', 10);
            try {
                const content = readFileSync(logger.getLogPath(), 'utf8');
                const allLines = content.split('\n').filter(Boolean);
                server.sendRpcResponse(id, {
                    lines: allLines.slice(-count),
                    logPath: logger.getLogPath(),
                });
            } catch {
                server.sendRpcResponse(id, { lines: [], logPath: logger.getLogPath() });
            }
            return;
        }
        server.sendRpcResponse(id, null, `unknown method: ${method}`);
    }

    function dispose(): void {
        abortController.abort();
        geminiSession?.dispose();
    }

    return {
        handleInput,
        handleRpc,
        getClaudeSessionId: () => claudeSessionId,
        dispose,
    };
}

/**
 * Session operations — direct-connect mode.
 * All RPCs go through directSocket; the sessionId param is kept for API compatibility
 * but is not used for routing (there is only one active CLI session at a time).
 */

import { directSocket } from './directSocket';
import type { MachineMetadata } from './storageTypes';

// ── Response types ────────────────────────────────────────────────────────────

export interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

export interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

interface SessionReadFileRequest {
    path: string;
}

export interface SessionReadFileResponse {
    success: boolean;
    content?: string;
    error?: string;
}

interface SessionWriteFileRequest {
    path: string;
    content: string;
    expectedHash?: string | null;
}

export interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

interface SessionListDirectoryRequest {
    path: string;
}

export interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}

export interface SessionListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

interface SessionGetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

export interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[];
}

export interface SessionGetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
}

export interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

export interface SessionKillResponse {
    success: boolean;
    message: string;
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: 'codex' | 'claude' | 'gemini' | 'openclaw';
}

export interface ResumeSessionOptions {
    machineId: string;
    sessionId: string;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function rpcId(): string {
    return Math.random().toString(36).slice(2);
}

async function sessionRPC<T>(method: string, params: unknown): Promise<T> {
    const res = await directSocket.rpc(rpcId(), method, params);
    if (res.error) throw new Error(res.error);
    return res.result as T;
}

// ── Session operations ────────────────────────────────────────────────────────

export async function sessionAbort(_sessionId: string): Promise<void> {
    await directSocket.rpc(rpcId(), 'abort', {
        reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
    });
}

export async function sessionAllow(
    _sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'approved' | 'approved_for_session',
    updatedInput?: Record<string, unknown>
): Promise<void> {
    await directSocket.rpc(rpcId(), 'permissionResponse', {
        permissionId: id,
        approved: true,
        mode,
        allowTools: allowedTools,
        decision,
        updatedInput,
    });
}

export async function sessionDeny(
    _sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'denied' | 'abort'
): Promise<void> {
    await directSocket.rpc(rpcId(), 'permissionResponse', {
        permissionId: id,
        approved: false,
        mode,
        allowTools: allowedTools,
        decision,
    });
}

export async function sessionBash(_sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        return await sessionRPC<SessionBashResponse>('bash', request);
    } catch (error) {
        return { success: false, stdout: '', stderr: error instanceof Error ? error.message : 'Unknown error', exitCode: -1, error: String(error) };
    }
}

export async function sessionReadFile(_sessionId: string, path: string): Promise<SessionReadFileResponse> {
    try {
        return await sessionRPC<SessionReadFileResponse>('readFile', { path });
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionWriteFile(
    _sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null
): Promise<SessionWriteFileResponse> {
    try {
        return await sessionRPC<SessionWriteFileResponse>('writeFile', { path, content, expectedHash });
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionListDirectory(_sessionId: string, path: string): Promise<SessionListDirectoryResponse> {
    try {
        return await sessionRPC<SessionListDirectoryResponse>('listDirectory', { path });
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionGetDirectoryTree(
    _sessionId: string,
    path: string,
    maxDepth: number
): Promise<SessionGetDirectoryTreeResponse> {
    try {
        return await sessionRPC<SessionGetDirectoryTreeResponse>('getDirectoryTree', { path, maxDepth });
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionRipgrep(
    _sessionId: string,
    args: string[],
    cwd?: string
): Promise<SessionRipgrepResponse> {
    try {
        return await sessionRPC<SessionRipgrepResponse>('ripgrep', { args, cwd });
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionKill(_sessionId: string): Promise<SessionKillResponse> {
    try {
        return await sessionRPC<SessionKillResponse>('killSession', {});
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionArchive(_sessionId: string): Promise<{ success: boolean; message?: string }> {
    return { success: false, message: 'Not supported in direct-connect mode' };
}

export async function sessionDelete(_sessionId: string): Promise<{ success: boolean; message?: string }> {
    return { success: false, message: 'Not supported in direct-connect mode' };
}

// ── Machine operations (not applicable in direct-connect mode) ────────────────

export async function machineSpawnNewSession(_options: SpawnSessionOptions): Promise<SpawnSessionResult> {
    return { type: 'error', errorMessage: 'Not supported in direct-connect mode' };
}

export async function machineResumeSession(_options: ResumeSessionOptions): Promise<SpawnSessionResult> {
    return { type: 'error', errorMessage: 'Not supported in direct-connect mode' };
}

export async function machineDelete(_machineId: string): Promise<{ success: boolean; message?: string }> {
    return { success: false, message: 'Not supported in direct-connect mode' };
}

export async function machineStopDaemon(_machineId: string): Promise<{ message: string }> {
    return { message: 'Not supported in direct-connect mode' };
}

export async function machineBash(
    _machineId: string,
    _command: string,
    _cwd: string
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
    return { success: false, stdout: '', stderr: 'Not supported in direct-connect mode', exitCode: -1 };
}

export async function machineUpdateMetadata(
    _machineId: string,
    _metadata: MachineMetadata,
    _expectedVersion: number,
    _maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    throw new Error('Not supported in direct-connect mode');
}

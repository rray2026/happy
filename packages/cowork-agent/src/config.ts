import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveHome(): string {
    const override = process.env.COWORK_AGENT_HOME;
    if (override) {
        return override.replace(/^~/, homedir());
    }
    return join(homedir(), '.cowork-agent');
}

export const homeDir = resolveHome();
export const logsDir = join(homeDir, 'logs');
export const keysPath = join(homeDir, 'serve-keys.json');
/**
 * Directory for per-session persistence: `<sessionsDir>/<chatSessionId>.json`,
 * one file per chat session carrying its metadata + CLI resume hints. Replaces
 * the legacy single-file `serve-state.json`, which could only track one
 * gemini session and so was incompatible with the multi-session design.
 */
export const sessionsDir = join(homeDir, 'sessions');
/** Legacy single-file state. Kept only to remove stale files on startup. */
const legacyStatePath = join(homeDir, 'serve-state.json');

if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

// One-time migration: the single-file state was replaced by per-session files
// in the multi-session refactor; delete any leftover file from older installs.
if (existsSync(legacyStatePath)) {
    try {
        rmSync(legacyStatePath, { force: true });
    } catch {
        /* ignore — harmless stale file */
    }
}

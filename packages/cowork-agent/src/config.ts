import { existsSync, mkdirSync } from 'node:fs';
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

if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

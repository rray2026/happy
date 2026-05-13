import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { homeDir } from './config.js';

export interface ConfigFile {
    workdir?: string;
    port?: number;
    bind?: string;
    endpoint?: string;
    agent?: 'claude' | 'gemini';
    model?: string;
    agentArgs?: string[];
}

export const defaultConfigPath = join(homeDir, 'config.json');

/**
 * Load and validate the optional JSON config file.
 *
 * - When `explicitPath` is set, the file MUST exist and parse — invalid input
 *   throws so the caller can fail-fast on startup.
 * - Otherwise falls back to `~/.cowork-agent/config.json` and returns null if
 *   it isn't there.
 *
 * Returned object carries only the fields that were present; merging against
 * env vars / defaults is the caller's job.
 */
export function loadConfigFile(explicitPath?: string): ConfigFile | null {
    const { path, mustExist } = resolveConfigPath(explicitPath);

    if (!existsSync(path)) {
        if (mustExist) throw new Error(`config file not found: ${path}`);
        return null;
    }

    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (err) {
        throw new Error(`failed to read config ${path}: ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`config ${path} is not valid JSON: ${(err as Error).message}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`config ${path}: expected an object at the top level`);
    }

    return validateConfig(parsed as Record<string, unknown>, path);
}

function resolveConfigPath(explicit: string | undefined): { path: string; mustExist: boolean } {
    if (explicit !== undefined && explicit !== '') {
        return { path: expandHome(explicit), mustExist: true };
    }
    return { path: defaultConfigPath, mustExist: false };
}

function validateConfig(o: Record<string, unknown>, path: string): ConfigFile {
    const out: ConfigFile = {};
    const fail = (msg: string): never => {
        throw new Error(`config ${path}: ${msg}`);
    };

    if (o.workdir !== undefined) {
        if (typeof o.workdir !== 'string') fail('workdir must be a string');
        out.workdir = o.workdir as string;
    }
    if (o.port !== undefined) {
        if (
            typeof o.port !== 'number' ||
            !Number.isInteger(o.port) ||
            o.port < 0 ||
            o.port > 65535
        ) {
            fail('port must be an integer 0..65535');
        }
        out.port = o.port as number;
    }
    if (o.bind !== undefined) {
        if (typeof o.bind !== 'string') fail('bind must be a string');
        out.bind = o.bind as string;
    }
    if (o.endpoint !== undefined) {
        if (typeof o.endpoint !== 'string') fail('endpoint must be a string');
        out.endpoint = o.endpoint as string;
    }
    if (o.agent !== undefined) {
        if (o.agent !== 'claude' && o.agent !== 'gemini') {
            fail('agent must be "claude" or "gemini"');
        }
        out.agent = o.agent as 'claude' | 'gemini';
    }
    if (o.model !== undefined) {
        if (typeof o.model !== 'string') fail('model must be a string');
        out.model = o.model as string;
    }
    if (o.agentArgs !== undefined) {
        if (!Array.isArray(o.agentArgs) || o.agentArgs.some((x) => typeof x !== 'string')) {
            fail('agentArgs must be an array of strings');
        }
        out.agentArgs = o.agentArgs as string[];
    }

    return out;
}

/**
 * Expand `~` (and `~/...`) to the user's home dir, then resolve to absolute.
 * Anything else is passed through `path.resolve` against the current cwd.
 */
export function expandHome(p: string): string {
    if (p === '~') return homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return join(homedir(), p.slice(2));
    }
    return isAbsolute(p) ? p : resolve(p);
}

/**
 * Validate `raw` as a workdir: must exist and be a directory. When `raw` is
 * unset, defaults to the process's current working directory.
 */
export function resolveWorkdir(raw: string | undefined): string {
    if (raw === undefined || raw === '') return process.cwd();
    const abs = expandHome(raw);
    let s: ReturnType<typeof statSync>;
    try {
        s = statSync(abs);
    } catch {
        throw new Error(`workdir does not exist: ${abs}`);
    }
    if (!s.isDirectory()) {
        throw new Error(`workdir is not a directory: ${abs}`);
    }
    return abs;
}

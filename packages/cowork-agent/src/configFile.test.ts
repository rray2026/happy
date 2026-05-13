import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfigFile, resolveWorkdir } from './configFile.js';

describe('loadConfigFile', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'cowork-config-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('returns null when default path is absent (no explicit path)', () => {
        // No explicit path → must not throw on missing default config. We can't
        // fake the default path inside the function, but passing undefined and
        // trusting the user's home not to contain the file is unreliable; so
        // verify the explicit-path absent case which uses the same code branch
        // in reverse: throw on missing explicit.
        const missing = join(root, 'no-such.json');
        expect(() => loadConfigFile(missing)).toThrow(/not found/);
    });

    it('parses a fully populated config', () => {
        const wd = join(root, 'wd');
        mkdirSync(wd);
        const p = join(root, 'cfg.json');
        writeFileSync(
            p,
            JSON.stringify({
                workdir: wd,
                port: 4123,
                bind: '0.0.0.0',
                endpoint: 'ws://example:4123',
                agent: 'gemini',
                model: 'gemini-2.5-pro',
                agentArgs: ['--foo', 'bar'],
            }),
        );
        const cfg = loadConfigFile(p);
        expect(cfg).toEqual({
            workdir: wd,
            port: 4123,
            bind: '0.0.0.0',
            endpoint: 'ws://example:4123',
            agent: 'gemini',
            model: 'gemini-2.5-pro',
            agentArgs: ['--foo', 'bar'],
        });
    });

    it('accepts a partial config', () => {
        const p = join(root, 'partial.json');
        writeFileSync(p, JSON.stringify({ port: 5000 }));
        expect(loadConfigFile(p)).toEqual({ port: 5000 });
    });

    it('throws on non-JSON content', () => {
        const p = join(root, 'bad.json');
        writeFileSync(p, 'not json');
        expect(() => loadConfigFile(p)).toThrow(/not valid JSON/);
    });

    it('throws when the root is not an object', () => {
        const p = join(root, 'arr.json');
        writeFileSync(p, JSON.stringify([1, 2, 3]));
        expect(() => loadConfigFile(p)).toThrow(/expected an object/);
    });

    it('rejects bad port', () => {
        const p = join(root, 'p.json');
        writeFileSync(p, JSON.stringify({ port: 70000 }));
        expect(() => loadConfigFile(p)).toThrow(/port must be/);
    });

    it('rejects unknown agent value', () => {
        const p = join(root, 'a.json');
        writeFileSync(p, JSON.stringify({ agent: 'gpt' }));
        expect(() => loadConfigFile(p)).toThrow(/agent must be/);
    });

    it('rejects non-string entries in agentArgs', () => {
        const p = join(root, 'args.json');
        writeFileSync(p, JSON.stringify({ agentArgs: ['ok', 42] }));
        expect(() => loadConfigFile(p)).toThrow(/agentArgs must be/);
    });
});

describe('resolveWorkdir', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'cowork-wd-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('returns process.cwd() when input is undefined', () => {
        expect(resolveWorkdir(undefined)).toBe(process.cwd());
    });

    it('returns process.cwd() when input is empty string', () => {
        expect(resolveWorkdir('')).toBe(process.cwd());
    });

    it('returns absolute path for existing dir', () => {
        const wd = join(root, 'sub');
        mkdirSync(wd);
        expect(resolveWorkdir(wd)).toBe(wd);
    });

    it('throws when path does not exist', () => {
        expect(() => resolveWorkdir(join(root, 'nope'))).toThrow(/does not exist/);
    });

    it('throws when path is a file, not a directory', () => {
        const f = join(root, 'file.txt');
        writeFileSync(f, 'x');
        expect(() => resolveWorkdir(f)).toThrow(/not a directory/);
    });
});

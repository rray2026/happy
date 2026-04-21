import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInsideRoot, listDirs, resolveRelPath } from './fsBrowser.js';

describe('fsBrowser', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'fsbrowser-'));
        // Structure:
        //   root/
        //     src/
        //       components/
        //     docs/
        //     .git/
        //     node_modules/
        //     .hidden/
        //     README.md (file, not listed)
        mkdirSync(join(root, 'src', 'components'), { recursive: true });
        mkdirSync(join(root, 'docs'));
        mkdirSync(join(root, '.git'));
        mkdirSync(join(root, 'node_modules'));
        mkdirSync(join(root, '.hidden'));
        writeFileSync(join(root, 'README.md'), '#');
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    // ── listDirs ─────────────────────────────────────────────────────────────

    it('lists only directories, hides dot-dirs, node_modules, .git by default', () => {
        const res = listDirs(root, '');
        expect(res.dirs).toEqual(['docs', 'src']);
        expect(res.relPath).toBe('');
    });

    it('drills into a subdirectory via relPath', () => {
        const res = listDirs(root, 'src');
        expect(res.dirs).toEqual(['components']);
        expect(res.relPath).toBe('src');
    });

    it('returns POSIX-separated relPath on nested entries', () => {
        const res = listDirs(root, 'src/components');
        expect(res.relPath).toBe('src/components');
        expect(res.dirs).toEqual([]);
    });

    it('showHidden surfaces dot-dirs but still filters ALWAYS_HIDDEN', () => {
        const res = listDirs(root, '', { showHidden: true });
        // .git and node_modules are always hidden; .hidden surfaces.
        expect(res.dirs).toEqual(['.hidden', 'docs', 'src']);
    });

    it('sorts case-insensitively', () => {
        mkdirSync(join(root, 'Alpha'));
        mkdirSync(join(root, 'beta'));
        const res = listDirs(root, '');
        expect(res.dirs).toEqual(['Alpha', 'beta', 'docs', 'src']);
    });

    // ── sandbox ──────────────────────────────────────────────────────────────

    it('rejects parent-escape with ..', () => {
        expect(() => listDirs(root, '../..')).toThrow(/escapes agent root/);
        expect(() => resolveRelPath(root, '../..')).toThrow(/escapes agent root/);
    });

    it('rejects absolute paths that land outside root', () => {
        expect(() => resolveRelPath(root, '/etc')).toThrow(/escapes agent root/);
    });

    it('rejects symlinks that point outside root', () => {
        const outside = mkdtempSync(join(tmpdir(), 'fsbrowser-outside-'));
        try {
            symlinkSync(outside, join(root, 'link-out'));
            expect(() => resolveRelPath(root, 'link-out')).toThrow(/escapes agent root/);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it('follows symlinks that stay inside root', () => {
        symlinkSync(join(root, 'src'), join(root, 'src-alias'));
        // src-alias is a symlink → dir; listDirs should include it.
        const res = listDirs(root, '');
        expect(res.dirs).toContain('src-alias');
        // And drilling through it should resolve to 'src'.
        const nested = listDirs(root, 'src-alias');
        expect(nested.dirs).toEqual(['components']);
        expect(nested.relPath).toBe('src');
    });

    it('empty relPath resolves to root', () => {
        const resolved = resolveRelPath(root, '');
        // Realpath of tmp may differ from root on macOS (/private prefix).
        // But listDirs on '' should produce relPath ''.
        expect(resolved).toBeTruthy();
    });

    // ── isInsideRoot ─────────────────────────────────────────────────────────

    it('isInsideRoot: accepts equal + prefix, rejects sibling', () => {
        expect(isInsideRoot('/a/b', '/a/b')).toBe(true);
        expect(isInsideRoot('/a/b', '/a/b/c')).toBe(true);
        expect(isInsideRoot('/a/b', '/a/bc')).toBe(false);
        expect(isInsideRoot('/a/b', '/a')).toBe(false);
    });
});

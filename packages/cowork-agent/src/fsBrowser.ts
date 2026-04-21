import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * Immediate-subdirectory listing bounded to an agent-launched root. Used by
 * the webapp's "pick a working directory for this session" flow.
 *
 *  - Paths are POSIX-separated on the wire so the webapp doesn't have to
 *    care about the agent's host OS.
 *  - A caller-supplied `relPath` is resolved against the real path of the
 *    root (symlinks followed). If the result escapes the root — even through
 *    a symlink — we refuse.
 *  - Hidden dot-dirs, VCS metadata, and `node_modules` are hidden by default
 *    because they're both noisy and usually uninteresting as session cwds.
 */

const ALWAYS_HIDDEN = new Set(['node_modules', '.git', '.svn', '.hg', '.DS_Store']);

export interface ListDirsResult {
    /** Absolute realpath of the agent root (stable across calls). */
    root: string;
    /**
     * Canonical POSIX relative path of the browsed directory. Empty string
     * means "the root itself".
     */
    relPath: string;
    /** Immediate-subdir names, case-insensitively sorted. */
    dirs: string[];
}

export interface ListDirsOptions {
    /** If true, surface dot-dirs (but not `ALWAYS_HIDDEN` entries). */
    showHidden?: boolean;
}

/**
 * Resolve `relPath` against `root` and return an absolute realpath that is
 * guaranteed to sit inside the root. Throws `'path escapes agent root'`
 * otherwise.
 *
 * If the target doesn't exist yet we fall back to the non-real resolved
 * path for the containment check — the caller is responsible for any
 * subsequent existence check.
 */
export function resolveRelPath(root: string, relPath: string): string {
    const rootReal = realpathSync(root);
    // `resolve()` handles both POSIX and Windows separators, and normalizes
    // `..` segments — which is exactly what we need for the escape check.
    const candidate = resolve(rootReal, relPath || '.');
    let candidateReal: string;
    try {
        candidateReal = realpathSync(candidate);
    } catch {
        candidateReal = candidate;
    }
    if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + sep)) {
        throw new Error('path escapes agent root');
    }
    return candidateReal;
}

export function listDirs(
    root: string,
    relPath: string,
    opts: ListDirsOptions = {},
): ListDirsResult {
    const rootReal = realpathSync(root);
    const abs = resolveRelPath(root, relPath);

    const entries = readdirSync(abs, { withFileTypes: true });
    const showHidden = opts.showHidden === true;

    const dirs = entries
        .filter((e) => {
            if (ALWAYS_HIDDEN.has(e.name)) return false;
            if (!showHidden && e.name.startsWith('.')) return false;
            if (e.isDirectory()) return true;
            // Follow symlinks one hop — chase resolve happens at use time.
            if (e.isSymbolicLink()) {
                try {
                    return statSync(join(abs, e.name)).isDirectory();
                } catch {
                    return false;
                }
            }
            return false;
        })
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    // Return relPath with POSIX separators for wire stability.
    const canonicalRel =
        abs === rootReal
            ? ''
            : abs.slice(rootReal.length + 1).split(sep).join('/');

    return { root: rootReal, relPath: canonicalRel, dirs };
}

/**
 * Tests whether `candidate` (absolute path) is inside (or equal to) `root`.
 * Both inputs should already be realpath-resolved.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(root + sep);
}

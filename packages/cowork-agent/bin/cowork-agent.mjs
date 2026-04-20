#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distEntry = join(projectRoot, 'dist', 'index.js');

if (existsSync(distEntry)) {
    await import(pathToFileURL(distEntry).href);
} else {
    // Dev mode: re-exec with tsx so TypeScript source can be executed directly.
    const tsxBin = join(projectRoot, 'node_modules', '.bin', 'tsx');
    if (!existsSync(tsxBin)) {
        console.error(
            '[cowork-agent] No dist/ build found and tsx is not installed. ' +
                'Run `npm install` inside packages/cowork-agent, or `npm run build`.',
        );
        process.exit(1);
    }
    try {
        execFileSync(tsxBin, [join(projectRoot, 'src', 'index.ts'), ...process.argv.slice(2)], {
            stdio: 'inherit',
            env: process.env,
        });
    } catch (err) {
        process.exit(err.status ?? 1);
    }
}

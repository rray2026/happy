#!/usr/bin/env node
// Fake `claude --print --output-format stream-json` for tests.
//
// Reads a JSON script from the file pointed to by env FAKE_CLI_SCRIPT.
// Script shape:
//   {
//     "steps": [
//       { "delayMs"?: number, "event": { ...anyJsonLine } },
//       { "delayMs"?: number, "stderr": "line to write to stderr" },
//       { "delayMs"?: number, "exitAfter": true }
//     ],
//     "exitCode"?: number    // defaults to 0; ignored if a step has exitAfter:true
//   }
//
// The prompt passed by the caller is the last argv; we echo it to stderr so
// tests can verify the CLI was invoked correctly.

import { readFileSync } from 'node:fs';

const scriptPath = process.env.FAKE_CLI_SCRIPT;
if (!scriptPath) {
    process.stderr.write('[fake-claude] FAKE_CLI_SCRIPT env not set\n');
    process.exit(2);
}

let script;
try {
    script = JSON.parse(readFileSync(scriptPath, 'utf8'));
} catch (err) {
    process.stderr.write(`[fake-claude] failed to read script: ${err.message}\n`);
    process.exit(2);
}

const prompt = process.argv[process.argv.length - 1];
process.stderr.write(`[fake-claude] prompt=${JSON.stringify(prompt)}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const steps = Array.isArray(script.steps) ? script.steps : [];
    for (const step of steps) {
        if (typeof step.delayMs === 'number' && step.delayMs > 0) {
            await sleep(step.delayMs);
        }
        if (step.stderr) {
            process.stderr.write(String(step.stderr) + '\n');
        }
        if (step.event !== undefined) {
            process.stdout.write(JSON.stringify(step.event) + '\n');
        }
        if (step.exitAfter) {
            process.exit(typeof step.exitCode === 'number' ? step.exitCode : 0);
        }
    }
    process.exit(typeof script.exitCode === 'number' ? script.exitCode : 0);
})().catch((err) => {
    process.stderr.write(`[fake-claude] crashed: ${err.message}\n`);
    process.exit(1);
});

#!/usr/bin/env node
import chalk from 'chalk';
import { handleServe, parseServeArgs } from './serve.js';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const sub = args[0];

    if (!sub || sub === 'serve') {
        const rest = sub === 'serve' ? args.slice(1) : args;
        const opts = parseServeArgs(rest);
        try {
            await handleServe(opts);
        } catch (err) {
            console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
            if (process.env.DEBUG) console.error(err);
            process.exit(1);
        }
        return;
    }

    if (sub === '-h' || sub === '--help') {
        printUsage();
        return;
    }

    console.error(chalk.red(`Unknown command: ${sub}`));
    printUsage();
    process.exit(1);
}

function printUsage(): void {
    console.log(
        [
            chalk.bold('cowork-agent') + ' — direct-connect bridge for cowork-webapp',
            '',
            chalk.bold('Usage:'),
            '  cowork-agent serve [--claude | --gemini] [--model NAME] [-- agent-args…]',
            '',
            chalk.bold('Flags:'),
            '  --claude           Use Claude Code CLI (default)',
            '  --gemini           Use Gemini CLI via ACP',
            '  --model, -m NAME   Pass --model NAME to the agent CLI',
            '',
            chalk.bold('Env:'),
            '  COWORK_AGENT_PORT       Port to listen on (default: 4000)',
            '  COWORK_AGENT_ENDPOINT   Public ws:// URL advertised in QR (default: ws://localhost:PORT)',
            '  COWORK_AGENT_HOME       Keys/logs dir (default: ~/.cowork-agent)',
            '  GEMINI_API_KEY          Passed to gemini CLI (optional)',
        ].join('\n'),
    );
}

main().catch((err) => {
    console.error(chalk.red('Fatal:'), err);
    process.exit(1);
});

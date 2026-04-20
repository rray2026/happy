import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { logsDir } from './config.js';

function makeFilename(): string {
    const now = new Date();
    const ts = now
        .toLocaleString('sv-SE', {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        })
        .replace(/[: ]/g, '-');
    return `${ts}-pid-${process.pid}.log`;
}

function stamp(): string {
    return new Date().toLocaleTimeString('en-US', {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
    });
}

class Logger {
    readonly logFilePath = join(logsDir, makeFilename());

    debug(message: string, ...args: unknown[]): void {
        const line =
            `[${stamp()}] ${message} ` +
            args
                .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 5, breakLength: 120 })))
                .join(' ') +
            '\n';
        try {
            appendFileSync(this.logFilePath, line);
        } catch {
            /* swallow — logging must never interrupt the agent */
        }
    }

    getLogPath(): string {
        return this.logFilePath;
    }
}

export const logger = new Logger();

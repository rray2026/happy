#!/usr/bin/env node
/**
 * Fake `claude --print --input-format stream-json` for tests.
 *
 * Reads JSON lines from stdin and writes stream-json events to stdout. Each
 * incoming user message produces a fixed event sequence (system/init →
 * assistant → result/success). Test scenarios are triggered by directives
 * embedded in the prompt text (parsed as `__DIRECTIVE__[:arg]`) so each test
 * can shape behavior without env munging:
 *
 *   __SLOW__:<ms>      delay between system/init and result by N ms
 *   __NO_RESULT__       emit init + assistant but never result (hangs the channel)
 *   __CRASH__          process.exit(2) before emitting any output
 *   __SESSION__:<id>   override the session_id field in init
 *
 * control_request {subtype:"interrupt"} is handled per the real protocol:
 * write control_response/success immediately, and if a turn is in-flight,
 * cancel its remaining timers and emit result/error_during_execution.
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

let nextSessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;
let inFlight = null; // { timers: NodeJS.Timeout[] }

function write(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function parseDirectives(content) {
    const directives = {};
    const re = /__([A-Z_]+)__(?::([^_\s]+))?/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        directives[m[1]] = m[2] ?? true;
    }
    return directives;
}

function startTurn(content) {
    const dir = parseDirectives(content);
    if (dir.CRASH) {
        process.exit(2);
    }
    if (dir.SESSION) {
        nextSessionId = String(dir.SESSION);
    }

    const timers = [];
    inFlight = { timers };

    write({ type: 'system', subtype: 'init', session_id: nextSessionId });
    write({
        type: 'assistant',
        session_id: nextSessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${content}` }] },
    });

    if (dir.NO_RESULT) {
        // Stay busy forever (until interrupted or killed)
        return;
    }

    const delayMs = dir.SLOW ? Math.max(0, parseInt(dir.SLOW, 10)) : 0;
    const t = setTimeout(() => {
        timers.length = 0;
        write({
            type: 'result',
            subtype: 'success',
            session_id: nextSessionId,
            result: `result: ${content}`,
        });
        inFlight = null;
    }, delayMs);
    timers.push(t);
}

function handleInterrupt() {
    write({ type: 'control_response', response: { subtype: 'success' } });
    if (inFlight) {
        for (const t of inFlight.timers) clearTimeout(t);
        write({
            type: 'result',
            subtype: 'error_during_execution',
            session_id: nextSessionId,
            result: null,
        });
        inFlight = null;
    }
}

rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    if (msg.type === 'user') {
        const content = msg.message?.content ?? '';
        startTurn(typeof content === 'string' ? content : JSON.stringify(content));
        return;
    }
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
        handleInterrupt();
        return;
    }
});

rl.on('close', () => {
    // Match real claude: exit cleanly when stdin closes (no in-flight task).
    if (!inFlight) {
        process.exit(0);
    }
    // If still in flight (e.g. NO_RESULT case), stay alive until killed.
});

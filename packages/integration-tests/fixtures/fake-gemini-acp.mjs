#!/usr/bin/env node
// Fake `gemini --experimental-acp` for tests.
//
// Speaks JSON-RPC 2.0 ndJSON over stdin/stdout. Handles:
//   initialize       → { protocolVersion: 1 }
//   session/new      → { sessionId: "fake-acp-001" }
//   session/load     → { sessionId: <resumeId> } if env FAKE_ACP_LOAD_OK=1
//                       else error -32000 'not found'
//   session/prompt   → emits `session/update` notifications according to the
//                       script, then returns { stopReason: 'end_turn' }
//
// Script (env FAKE_ACP_SCRIPT → JSON file path):
//   {
//     "onPrompt": [                // array of turns
//       [                          // turn 0: steps fired in order
//         { "delayMs"?: number, "update": { sessionUpdate: "...", ... } },
//         { "delayMs"?: number, "update": { ... } }
//       ],
//       [...]                      // turn 1
//     ],
//     "sessionId"?: "fake-acp-001"
//   }
//
// If the caller issues more prompts than onPrompt entries, extra prompts
// replay the last turn (or emit nothing if onPrompt is empty).

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scriptPath = process.env.FAKE_ACP_SCRIPT;
if (!scriptPath) {
    process.stderr.write('[fake-gemini] FAKE_ACP_SCRIPT env not set\n');
    process.exit(2);
}

let script;
try {
    script = JSON.parse(readFileSync(scriptPath, 'utf8'));
} catch (err) {
    process.stderr.write(`[fake-gemini] failed to read script: ${err.message}\n`);
    process.exit(2);
}

const turns = Array.isArray(script.onPrompt) ? script.onPrompt : [];
const baseSessionId = script.sessionId ?? 'fake-acp-001';
const loadOk = process.env.FAKE_ACP_LOAD_OK === '1';

let promptCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function write(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendNotification(method, params) {
    write({ jsonrpc: '2.0', method, params });
}

function sendResponse(id, result) {
    write({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
    write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handlePrompt(id, params) {
    const turnIdx = promptCount < turns.length ? promptCount : turns.length - 1;
    promptCount++;
    const steps = turnIdx >= 0 ? turns[turnIdx] ?? [] : [];
    const sessionId = params?.sessionId ?? baseSessionId;
    for (const step of steps) {
        if (typeof step.delayMs === 'number' && step.delayMs > 0) {
            await sleep(step.delayMs);
        }
        if (step.update) {
            sendNotification('session/update', { sessionId, update: step.update });
        }
    }
    sendResponse(id, { stopReason: 'end_turn' });
}

async function handleIncoming(msg) {
    if (!msg || msg.jsonrpc !== '2.0') return;
    const { id, method, params } = msg;

    if (method === 'initialize') {
        sendResponse(id, { protocolVersion: 1 });
        return;
    }
    if (method === 'session/new') {
        sendResponse(id, { sessionId: baseSessionId });
        return;
    }
    if (method === 'session/load') {
        if (loadOk) {
            sendResponse(id, { sessionId: params?.sessionId ?? baseSessionId });
        } else {
            sendError(id, -32000, 'not found');
        }
        return;
    }
    if (method === 'session/prompt') {
        await handlePrompt(id, params);
        return;
    }
    if (id !== undefined) {
        sendError(id, -32601, `method not found: ${method}`);
    }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        process.stderr.write(`[fake-gemini] bad JSON: ${trimmed.slice(0, 120)}\n`);
        return;
    }
    handleIncoming(parsed).catch((err) => {
        process.stderr.write(`[fake-gemini] handler error: ${err.message}\n`);
    });
});

rl.on('close', () => process.exit(0));

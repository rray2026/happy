import type {
    AssistantEvent,
    ClaudeEvent,
    Item,
    ResultEvent,
    SystemEvent,
    TextPart,
    ToolUsePart,
    UserEvent,
} from '../types';

let counter = 0;
export const uid = (): string => String(++counter);

/**
 * Reset the internal id counter. Test-only helper.
 */
export function __resetUidForTests(): void {
    counter = 0;
}

/**
 * Convert an incoming Claude event into zero or more UI display items.
 */
export function eventToItems(event: ClaudeEvent): Item[] {
    switch (event.type) {
        case 'user': {
            const e = event as UserEvent;
            const text = typeof e.message.content === 'string'
                ? e.message.content
                : (e.message.content.find((p): p is TextPart => p.type === 'text')?.text ?? '');
            return text ? [{ kind: 'user', text, id: uid() }] : [];
        }
        case 'assistant': {
            const e = event as AssistantEvent;
            // Finalize marker for a progressive stream — carries no text.
            if (e._final && e._streamId) {
                return [{ kind: 'assistant', text: '', id: e._streamId, streaming: false }];
            }
            // Progressive delta chunk — keyed on streamId so mergeItems can append.
            if (e._delta && e._streamId && e.message) {
                const text = e.message.content.filter((p): p is TextPart => p.type === 'text').map(p => p.text).join('');
                if (!text) return [];
                return [{ kind: 'assistant', text, id: e._streamId, streaming: true }];
            }
            // Non-streaming path (Claude, or tool-only assistant events from Gemini).
            const items: Item[] = [];
            const content = e.message?.content ?? [];
            const text = content.filter((p): p is TextPart => p.type === 'text').map(p => p.text).join('');
            if (text) items.push({ kind: 'assistant', text, id: uid() });
            const calls = content
                .filter((p): p is ToolUsePart => p.type === 'tool_use')
                .map((p) => ({ name: p.name, input: p.input, toolUseId: p.id }));
            if (calls.length) items.push({ kind: 'tools', calls, id: uid() });
            return items;
        }
        case 'result': {
            const e = event as ResultEvent;
            return e.subtype === 'error' ? [{ kind: 'result', text: e.result || 'error', success: false, id: uid() }] : [];
        }
        case 'system': {
            const e = event as SystemEvent;
            return e.session_id ? [{ kind: 'status', text: `Session ${e.session_id.slice(0, 8)}…`, id: uid() }] : [];
        }
        default:
            return [];
    }
}

/**
 * Merge new items into an existing list, applying tool-call grouping and
 * duplicate-user-message de-dup rules.
 */
export function mergeItems(prev: Item[], incoming: Item[]): Item[] {
    const merged = [...prev];
    for (const item of incoming) {
        if (item.kind === 'tools') {
            const last = merged[merged.length - 1];
            if (last?.kind === 'tools') {
                merged[merged.length - 1] = { ...last, calls: [...last.calls, ...item.calls] };
                continue;
            }
        }
        // Progressive assistant streaming: append text into the existing same-id item.
        if (item.kind === 'assistant' && item.streaming) {
            const idx = findLastIndex(merged, (m) => m.kind === 'assistant' && m.id === item.id);
            if (idx >= 0) {
                const prevItem = merged[idx] as Extract<Item, { kind: 'assistant' }>;
                merged[idx] = { ...prevItem, text: prevItem.text + item.text, streaming: true };
                continue;
            }
        }
        // Finalize marker: flip streaming off on the existing same-id item; drop marker.
        if (item.kind === 'assistant' && item.streaming === false && item.text === '') {
            const idx = findLastIndex(merged, (m) => m.kind === 'assistant' && m.id === item.id);
            if (idx >= 0) {
                const prevItem = merged[idx] as Extract<Item, { kind: 'assistant' }>;
                merged[idx] = { ...prevItem, streaming: false };
                continue;
            }
            // No matching stream — drop the bare finalize (nothing to render).
            continue;
        }
        if (item.kind === 'user') {
            const last = merged[merged.length - 1];
            if (last?.kind === 'user' && last.text === item.text) continue;
        }
        merged.push(item);
    }
    return merged;
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
    return -1;
}

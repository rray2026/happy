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
            const items: Item[] = [];
            const text = e.message.content.filter((p): p is TextPart => p.type === 'text').map(p => p.text).join('');
            if (text) items.push({ kind: 'assistant', text, id: uid() });
            const calls = e.message.content
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
        if (item.kind === 'user') {
            const last = merged[merged.length - 1];
            if (last?.kind === 'user' && last.text === item.text) continue;
        }
        merged.push(item);
    }
    return merged;
}

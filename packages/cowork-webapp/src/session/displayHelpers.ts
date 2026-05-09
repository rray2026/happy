import type { ChatSessionMeta } from '../types';
import { loadNames } from './nameStore';

/** Tool + model fallback used whenever the user hasn't named a session. */
export function defaultName(s: ChatSessionMeta): string {
    const tool = s.tool === 'claude' ? 'Claude' : 'Gemini';
    return s.model ? `${tool} · ${s.model}` : tool;
}

/** User-given name from local storage when present, otherwise the default. */
export function displayName(s: ChatSessionMeta, names = loadNames()): string {
    return names[s.id] ?? defaultName(s);
}

/** Relative-then-absolute formatter used by every session-list UI. */
export function formatSessionTime(ms: number): string {
    const now = Date.now();
    const diff = now - ms;
    const d = new Date(ms);
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** Short status string for the busy/pending indicator. */
export function busyLabel(s: ChatSessionMeta): string | null {
    if (!s.busy) return null;
    return (s.pending ?? 0) > 0 ? `运行中 · ${s.pending} 排队` : '运行中';
}

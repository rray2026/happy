import type { ReactNode } from 'react';
import type { ToolCall } from '../types';

export interface ToolCallSummary {
    /** One-line summary rendered inline next to the tool name in the header. */
    primary: ReactNode;
    /** Optional richer block rendered when the tool call is expanded. */
    body?: ReactNode;
}

function asString(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

function shortenMid(s: string, max = 60): string {
    if (!s) return '';
    if (s.length <= max) return s;
    const head = Math.ceil((max - 1) / 2);
    const tail = Math.floor((max - 1) / 2);
    return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function clip(s: string, max = 80): string {
    if (!s) return '';
    return s.length <= max ? s : s.slice(0, max) + '…';
}

function tryFormatJson(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try {
        return JSON.stringify(v, null, 2);
    } catch {
        return String(v);
    }
}

type Renderer = (input: unknown) => ToolCallSummary;
type Input = Record<string, unknown>;

const renderBash: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    const command = asString(input.command);
    const isBg = Boolean(input.run_in_background);
    return {
        primary: (
            <>
                <code className="tool-arg-code">{clip(command, 70)}</code>
                {isBg && <span className="tool-arg-meta">(后台)</span>}
            </>
        ),
        body: (
            <>
                <pre className="tool-body-code">{command}</pre>
                {input.description ? (
                    <div className="tool-body-meta">{asString(input.description)}</div>
                ) : null}
                {input.timeout != null && (
                    <div className="tool-body-meta">timeout {asString(input.timeout)}ms</div>
                )}
            </>
        ),
    };
};

const renderBashOutput: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    return {
        primary: <span className="tool-arg-meta">读取后台 shell {asString(input.bash_id)}</span>,
        body: input.filter ? <div className="tool-body-meta">filter: {asString(input.filter)}</div> : undefined,
    };
};

const renderKillShell: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    return {
        primary: <span className="tool-arg-meta">kill {asString(input.shell_id ?? input.bash_id)}</span>,
    };
};

const renderRead: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    const path = asString(input.file_path);
    const offset = input.offset;
    const limit = input.limit;
    const range: string[] = [];
    if (offset != null) range.push(`从 ${asString(offset)} 行`);
    if (limit != null) range.push(`读 ${asString(limit)} 行`);
    return {
        primary: (
            <>
                <span className="tool-arg-path">{shortenMid(path, 60)}</span>
                {range.length > 0 && <span className="tool-arg-meta">{range.join(' · ')}</span>}
            </>
        ),
    };
};

const renderEdit: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    const path = asString(input.file_path);
    const oldStr = asString(input.old_string);
    const newStr = asString(input.new_string);
    const replaceAll = Boolean(input.replace_all);
    return {
        primary: (
            <>
                <span className="tool-arg-path">{shortenMid(path, 50)}</span>
                {replaceAll && <span className="tool-arg-meta">(replace all)</span>}
            </>
        ),
        body: (
            <>
                <pre className="tool-body-code tool-diff-old">{clip(oldStr, 600)}</pre>
                <pre className="tool-body-code tool-diff-new">{clip(newStr, 600)}</pre>
            </>
        ),
    };
};

const renderWrite: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    const path = asString(input.file_path);
    const content = asString(input.content);
    return {
        primary: (
            <>
                <span className="tool-arg-path">{shortenMid(path, 50)}</span>
                <span className="tool-arg-meta">{content.length} 字符</span>
            </>
        ),
        body: <pre className="tool-body-code">{clip(content, 800)}</pre>,
    };
};

const renderGrep: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    const pattern = asString(input.pattern);
    const glob = asString(input.glob);
    const path = asString(input.path);
    const where = glob || (path ? shortenMid(path, 30) : '');
    return {
        primary: (
            <>
                <code className="tool-arg-code">{clip(pattern, 50)}</code>
                {where && <span className="tool-arg-meta">in {where}</span>}
            </>
        ),
        body: (
            <div className="tool-body-meta">
                {input.output_mode ? <div>output: {asString(input.output_mode)}</div> : null}
                {input.head_limit != null ? <div>head: {asString(input.head_limit)}</div> : null}
                {input['-i'] ? <div>case insensitive</div> : null}
                {input.multiline ? <div>multiline</div> : null}
            </div>
        ),
    };
};

const renderGlob: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    const pattern = asString(input.pattern);
    const path = asString(input.path);
    return {
        primary: (
            <>
                <code className="tool-arg-code">{clip(pattern, 60)}</code>
                {path && <span className="tool-arg-meta">in {shortenMid(path, 30)}</span>}
            </>
        ),
    };
};

interface Todo {
    content?: string;
    activeForm?: string;
    status?: string;
}

const renderTodoWrite: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    const todos = (Array.isArray(input.todos) ? input.todos : []) as Todo[];
    const counts = todos.reduce(
        (acc, t) => {
            const k = (t?.status as keyof typeof acc) ?? 'pending';
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
        },
        { pending: 0, in_progress: 0, completed: 0 } as Record<string, number>,
    );
    return {
        primary: (
            <span className="tool-arg-meta">
                {todos.length} 项 · {counts.completed} 完成 · {counts.in_progress} 进行 · {counts.pending} 待办
            </span>
        ),
        body: (
            <ul className="tool-body-todos">
                {todos.map((t, i) => (
                    <li key={i} className={`tool-todo tool-todo-${t?.status ?? 'pending'}`}>
                        <span className="tool-todo-marker" aria-hidden="true">
                            {t?.status === 'completed' ? '✓' : t?.status === 'in_progress' ? '▸' : '○'}
                        </span>
                        <span>{t?.status === 'in_progress' ? (t?.activeForm ?? t?.content ?? '') : (t?.content ?? '')}</span>
                    </li>
                ))}
            </ul>
        ),
    };
};

const renderWebFetch: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    const url = asString(input.url);
    const prompt = asString(input.prompt);
    return {
        primary: <span className="tool-arg-path">{shortenMid(url, 60)}</span>,
        body: prompt ? <div className="tool-body-meta">{clip(prompt, 200)}</div> : undefined,
    };
};

const renderWebSearch: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    return {
        primary: <code className="tool-arg-code">{clip(asString(input.query), 70)}</code>,
    };
};

const renderTask: Renderer = (raw) => {
    const input = (raw as Input) ?? {};
    return {
        primary: (
            <>
                <span className="tool-arg-meta">{asString(input.subagent_type) || 'agent'}</span>
                <span className="tool-arg-path">{clip(asString(input.description), 60)}</span>
            </>
        ),
        body: input.prompt ? <pre className="tool-body-code">{clip(asString(input.prompt), 600)}</pre> : undefined,
    };
};

const renderPermission: Renderer = (raw) => ({
    primary: <span className="tool-arg-meta">权限请求</span>,
    body: <pre className="tool-body-code">{tryFormatJson(raw)}</pre>,
});

const REGISTRY: Record<string, Renderer> = {
    Bash: renderBash,
    BashOutput: renderBashOutput,
    KillShell: renderKillShell,
    KillBash: renderKillShell,
    Read: renderRead,
    Edit: renderEdit,
    Write: renderWrite,
    NotebookEdit: renderEdit,
    Grep: renderGrep,
    Glob: renderGlob,
    TodoWrite: renderTodoWrite,
    WebFetch: renderWebFetch,
    WebSearch: renderWebSearch,
    Task: renderTask,
    AskUserQuestion: renderPermission,
};

const fallback: Renderer = (raw) => {
    const preview = clip(asString(raw), 80);
    return {
        primary: preview ? <span className="tool-arg-meta">{preview}</span> : null,
        body: <pre className="tool-body-code">{tryFormatJson(raw)}</pre>,
    };
};

export function summarizeToolCall(call: ToolCall): ToolCallSummary {
    const renderer = REGISTRY[call.name] ?? fallback;
    return renderer(call.input);
}

/**
 * Qwen polish: call Alibaba's DashScope OpenAI-compatible endpoint from the
 * browser to clean up a voice-recognition transcript before sending it to
 * the main agent. Stateless — every call is one independent chat completion.
 *
 * The browser direct-call route trades some defense-in-depth (API key sits in
 * localStorage) for zero extra latency and zero cowork-agent plumbing — the
 * polish has to land in under ~1s for the preview UX to feel responsive, and
 * a round-trip through the agent + a CLI subprocess wouldn't make it.
 */

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const DEFAULT_TIMEOUT_MS = 5000;

const SYSTEM_PROMPT = `你是语音输入文本清理助手。用户的语音通过 STT 转写而来，可能含口头语、同音错字、不完整句子。请将它清理为干净、表意清晰的指令，发送给 AI 编程助手。

铁律（违反任意一条都算失败）：
1. 保留原意——不添加、不补全、不推测用户没说的内容
2. 保留专业术语、英文、代码名词、文件路径、命令原样
3. 删除"嗯/呃/那个/就是说/对吧/这个"等口头语和明显重复
4. 修正语境下明显的同音错字（编程场景，例：还书→函数、停滞→停止）；不确定时保留原文
5. 即使原文不完整也按现状返回，不补全
6. 若原文已通顺，原样返回
7. 只输出清理后的纯文本，无引号、无解释、无 markdown、无前后空行`;

export interface PolishOptions {
    apiKey: string;
    model: string;
    /** Extra hint appended to the system prompt — useful for domain-specific
     *  vocabulary (e.g. "我说的是 Rust + WASM 项目，专业术语保留英文原样"). */
    extraHint?: string;
    /** Wall-clock budget for the round-trip. 5s is generous for qwen-flash
     *  tier; aborting and falling back to raw preview is better than letting
     *  the user wait. */
    timeoutMs?: number;
    /** Optional external signal so callers can cancel the polish when the
     *  user starts new speech mid-flight. Composed with the internal timeout. */
    signal?: AbortSignal;
    /** Optional override for tests. */
    fetchImpl?: typeof fetch;
}

export class QwenPolishError extends Error {
    constructor(message: string, public readonly kind: 'auth' | 'rate-limit' | 'timeout' | 'network' | 'server' | 'parse' | 'empty') {
        super(message);
        this.name = 'QwenPolishError';
    }
}

/** Strip stray wrappers that small models sometimes add despite the prompt:
 *  surrounding quotes, ```fenced blocks, trailing periods on single-word
 *  outputs, leading "清理后：" labels. */
function unwrapModelOutput(s: string): string {
    let out = s.trim();
    // ```...``` fenced
    out = out.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
    // Leading label our prompt accidentally invites
    out = out.replace(/^(清理后|润色后|输出)[:：]\s*/u, '');
    // Surrounding quotes (both ASCII and full-width)
    const pairs: Array<[string, string]> = [['"', '"'], ['"', '"'], ['「', '」'], ['『', '』'], ["'", "'"]];
    for (const [open, close] of pairs) {
        if (out.startsWith(open) && out.endsWith(close)) {
            out = out.slice(open.length, out.length - close.length).trim();
        }
    }
    return out;
}

/**
 * Polish a raw voice transcript. Throws QwenPolishError on any failure mode
 * the caller might want to distinguish; callers in the voice preview path
 * should fall back to showing the raw text on any error rather than send.
 */
export async function polishText(raw: string, opts: PolishOptions): Promise<string> {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (!opts.apiKey) throw new QwenPolishError('API key missing', 'auth');

    const fetchImpl = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Compose external cancel with internal timeout — either fires the same
    // abort. Caller's signal lets the voice-preview flow drop in-flight
    // polishes when the user resumes speaking.
    if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const system = opts.extraHint?.trim()
        ? `${SYSTEM_PROMPT}\n\n额外提示：${opts.extraHint.trim()}`
        : SYSTEM_PROMPT;

    let res: Response;
    try {
        res = await fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify({
                model: opts.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: trimmed },
                ],
                // Slight bias towards deterministic cleanup over creative
                // rewriting; the bar is "minimal change preserving intent".
                temperature: 0.2,
                // Small cap — polish output should never be longer than the
                // input by much; saves tokens and bounds latency further.
                max_tokens: Math.max(64, trimmed.length * 2),
                // DashScope extension: disable chain-of-thought tokens on
                // models that have a reasoning mode (qwen3-series). For the
                // polish task we want one-shot cleanup, not extended
                // deliberation — measured ~3x faster without quality loss
                // on `qwen-plus` / `qwen3.6-flash`. Ignored by models that
                // don't support reasoning.
                enable_thinking: false,
            }),
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if ((err as Error).name === 'AbortError') throw new QwenPolishError('polish timed out', 'timeout');
        throw new QwenPolishError(`network error: ${(err as Error).message}`, 'network');
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
        throw new QwenPolishError(`auth rejected (${res.status})`, 'auth');
    }
    if (res.status === 429) {
        throw new QwenPolishError('rate limited (429)', 'rate-limit');
    }
    if (!res.ok) {
        throw new QwenPolishError(`server ${res.status}`, 'server');
    }

    let body: unknown;
    try {
        body = await res.json();
    } catch (err) {
        throw new QwenPolishError(`parse error: ${(err as Error).message}`, 'parse');
    }
    const content = extractContent(body);
    if (content === null) throw new QwenPolishError('no content in response', 'parse');
    const out = unwrapModelOutput(content);
    if (!out) throw new QwenPolishError('empty content', 'empty');
    return out;
}

/** Tolerant extraction from OpenAI-compatible JSON. Returns null if the
 *  shape is unexpected rather than throwing — the caller turns null into a
 *  QwenPolishError with kind='parse'. */
function extractContent(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0] as { message?: { content?: unknown } };
    const content = first?.message?.content;
    if (typeof content !== 'string') return null;
    return content;
}

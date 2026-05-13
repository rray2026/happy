import { describe, expect, it, vi } from 'vitest';
import { polishText, QwenPolishError } from './qwen';

function mockOk(content: string): typeof fetch {
    return vi.fn(async () => new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;
}

const opts = (override: Partial<Parameters<typeof polishText>[1]> = {}) => ({
    apiKey: 'sk-test',
    model: 'qwen3.6-flash',
    fetchImpl: mockOk('停止函数'),
    timeoutMs: 1000,
    ...override,
});

describe('polishText', () => {
    it('returns the polished content', async () => {
        const out = await polishText('嗯那个停止函数', opts());
        expect(out).toBe('停止函数');
    });

    it('returns empty string for empty input without calling the API', async () => {
        const fetchImpl = vi.fn();
        const out = await polishText('   ', opts({ fetchImpl: fetchImpl as unknown as typeof fetch }));
        expect(out).toBe('');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('throws auth error when API key is empty', async () => {
        await expect(polishText('hello', opts({ apiKey: '' }))).rejects.toThrow(QwenPolishError);
    });

    it('strips surrounding quotes the model may wrap output with', async () => {
        const out = await polishText('hi', opts({ fetchImpl: mockOk('"清理结果"') }));
        expect(out).toBe('清理结果');
    });

    it('strips ```fenced``` blocks', async () => {
        const out = await polishText('hi', opts({ fetchImpl: mockOk('```\n清理结果\n```') }));
        expect(out).toBe('清理结果');
    });

    it('strips leading label like "清理后:"', async () => {
        const out = await polishText('hi', opts({ fetchImpl: mockOk('清理后：清理结果') }));
        expect(out).toBe('清理结果');
    });

    it('throws auth error on 401', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
        try {
            await polishText('hi', opts({ fetchImpl: fetchImpl as unknown as typeof fetch }));
            expect.fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(QwenPolishError);
            expect((e as QwenPolishError).kind).toBe('auth');
        }
    });

    it('throws rate-limit error on 429', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 429 }));
        try {
            await polishText('hi', opts({ fetchImpl: fetchImpl as unknown as typeof fetch }));
            expect.fail();
        } catch (e) {
            expect((e as QwenPolishError).kind).toBe('rate-limit');
        }
    });

    it('throws server error on 5xx', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }));
        try {
            await polishText('hi', opts({ fetchImpl: fetchImpl as unknown as typeof fetch }));
            expect.fail();
        } catch (e) {
            expect((e as QwenPolishError).kind).toBe('server');
        }
    });

    it('throws parse error when content field is missing', async () => {
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify({ choices: [{}] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        try {
            await polishText('hi', opts({ fetchImpl: fetchImpl as unknown as typeof fetch }));
            expect.fail();
        } catch (e) {
            expect((e as QwenPolishError).kind).toBe('parse');
        }
    });

    it('throws empty error when content is whitespace', async () => {
        try {
            await polishText('hi', opts({ fetchImpl: mockOk('   ') }));
            expect.fail();
        } catch (e) {
            expect((e as QwenPolishError).kind).toBe('empty');
        }
    });

    it('throws timeout error when fetch is slow', async () => {
        const fetchImpl = vi.fn(
            (_url: string, init?: RequestInit) =>
                new Promise<Response>((_, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
                    // never resolves
                }),
        );
        try {
            await polishText('hi', opts({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 30 }));
            expect.fail();
        } catch (e) {
            expect((e as QwenPolishError).kind).toBe('timeout');
        }
    });

    it('includes extraHint in the system message', async () => {
        let captured: string | undefined;
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(init?.body as string) as { messages: Array<{ role: string; content: string }> };
            captured = body.messages[0].content;
            return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
        });
        await polishText('hi', opts({ fetchImpl: fetchImpl as unknown as typeof fetch, extraHint: '专业术语保留英文' }));
        expect(captured).toMatch(/专业术语保留英文/);
    });
});

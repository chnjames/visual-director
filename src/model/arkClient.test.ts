import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runProbe } from './arkClient';
import { ARK_DEFAULT_BASE_URLS, buildArkUpstreamUrl } from '../shared/constants';
import type { ChatMessage } from './prompts';

const SECRET = 'sk-client-secret-7777';
const SETTINGS = {
  apiKey: SECRET,
  seedEndpoint: 'ep-client-001',
  imageEndpoint: 'ep-image-001',
  protocol: 'openai' as const,
  baseUrl: ARK_DEFAULT_BASE_URLS.openai,
};
const MSGS: ChatMessage[] = [{ role: 'user', content: 'hello' }];

function upstreamOk(content: string) {
  return { choices: [{ message: { content } }], id: 'rid-c' };
}

describe('arkClient 浏览器客户端', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('未配置 → not-configured，且完全不发起请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await runProbe('recipe', null, MSGS, (x) => x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorClass).toBe('not-configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Endpoint 为 URL → illegal-endpoint，不发起请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await runProbe(
      'recipe',
      { apiKey: SECRET, seedEndpoint: 'https://evil.com', imageEndpoint: 'ep-image-001', protocol: 'openai', baseUrl: ARK_DEFAULT_BASE_URLS.openai },
      MSGS,
      (x) => x,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorClass).toBe('illegal-endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功：直接请求配置的 Base URL，Key 只在鉴权头', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(upstreamOk('{"hello":1}')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await runProbe('recipe', SETTINGS, MSGS, (x) => x as { hello: number });
    expect(r.ok).toBe(true);

    const url = fetchMock.mock.calls[0][0];
    const init = fetchMock.mock.calls[0][1]!;
    expect(String(url)).toBe(buildArkUpstreamUrl('openai', ARK_DEFAULT_BASE_URLS.openai));
    expect(String(url)).not.toContain(SECRET);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(init.body as string);
    expect(body.apiKey).toBeUndefined();
    expect(body.baseUrl).toBeUndefined();
    expect(body.model).toBe('ep-client-001');
    expect(body.messages).toEqual(MSGS);
  });

  it('文本请求使用 textApiKey，不用图片通道的 Key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(upstreamOk('{"hello":1}')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const textKey = 'sk-text-only-3333';
    await runProbe(
      'recipe',
      {
        ...SETTINGS,
        apiKey: 'sk-should-not-use',
        imageApiKey: 'sk-image-only-1111',
        textApiKey: textKey,
      },
      MSGS,
      (x) => x as { hello: number },
    );
    const init = fetchMock.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${textKey}`);
    expect(String(init.body)).not.toContain(textKey);
    expect(String(init.body)).not.toContain('sk-image-only-1111');
  });

  it('模型返回非法 JSON → illegal-json，且保留原始输出', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(upstreamOk('not a json at all')), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await runProbe('recipe', SETTINGS, MSGS, (x) => x);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorClass).toBe('illegal-json');
      expect(r.raw?.rawContent).toBe('not a json at all');
    }
  });

  it('装配器抛 ZodError 形态 → schema-violation，不伪装成功', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(upstreamOk('{"a":1}')), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await runProbe(
      'recipe',
      SETTINGS,
      MSGS,
      () => {
        const e = new Error('zod') as Error & { issues: unknown[] };
        e.issues = [{ path: ['fields'], message: '必须恰好包含 12 个字段' }];
        throw e;
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorClass).toBe('schema-violation');
      expect(r.message).toContain('12');
    }
  });

  it('网络失败 → network；AbortError → timeout，均不抛出到 UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    const r1 = await runProbe('recipe', SETTINGS, MSGS, (x) => x);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errorClass).toBe('network');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }),
    );
    const r2 = await runProbe('recipe', SETTINGS, MSGS, (x) => x);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errorClass).toBe('timeout');
  });

  it('上游 401 → invalid-key', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          errorClass: 'invalid-key',
          message: 'Unauthorized',
          diagnostics: { model: 'ep-client-001', endpointMasked: 'ep-cl…-001' },
        }),
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await runProbe('recipe', SETTINGS, MSGS, (x) => x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorClass).toBe('invalid-key');
  });
});

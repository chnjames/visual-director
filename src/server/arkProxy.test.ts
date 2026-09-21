import { describe, it, expect, vi } from 'vitest';
import { handleArkRequest, API_KEY_HEADER } from './arkProxy';
import {
  ARK_DEFAULT_BASE_URLS,
  PROXY_PATH,
  buildArkUpstreamUrl,
} from '../shared/constants';

const SECRET = 'sk-proxy-secret-9999';
const OPENAI_URL = buildArkUpstreamUrl('openai', ARK_DEFAULT_BASE_URLS.openai);
const ANTHROPIC_URL = buildArkUpstreamUrl('anthropic', ARK_DEFAULT_BASE_URLS.anthropic);

function makeRequest(body: unknown, key: string | null = SECRET): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) headers[API_KEY_HEADER] = key;
  return new Request(`http://localhost${PROXY_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function openaiBody(extra: Record<string, unknown> = {}) {
  return {
    protocol: 'openai' as const,
    baseUrl: ARK_DEFAULT_BASE_URLS.openai,
    model: 'ep-ok-001',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.2,
    ...extra,
  };
}

function openaiSuccess(content = '{"ok":true}') {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'rid-123' } },
  );
}

describe('arkProxy OpenAI 协议与 Base URL', () => {
  it('成功：请求默认 OpenAI 地址，Key 仅在 Authorization 头，白名单字段转发', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => openaiSuccess());
    const res = await handleArkRequest(makeRequest(openaiBody()), { fetchImpl: fetchMock });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.diagnostics.totalTokens).toBe(15);

    expect(String(fetchMock.mock.calls[0][0])).toBe(OPENAI_URL);
    const init = fetchMock.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    const forwarded = JSON.parse(init.body as string);
    expect(forwarded.model).toBe('ep-ok-001');
    expect(forwarded.messages).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(SECRET);
  });

  it('未传 baseUrl 时回落到 OpenAI 默认地址；额外字段被丢弃', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => openaiSuccess());
    const { baseUrl: _omit, ...noBase } = openaiBody();
    await handleArkRequest(
      makeRequest({ ...noBase, evilField: 'pwned', evilUrl: 'https://evil.com' }),
      { fetchImpl: fetchMock },
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(OPENAI_URL);
    const forwarded = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(forwarded.evilField).toBeUndefined();
    expect(forwarded.evilUrl).toBeUndefined();
  });

  it('允许在官方域名下修改 Base URL 路径，并据此拼接地址', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => openaiSuccess());
    await handleArkRequest(
      makeRequest(openaiBody({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })),
      { fetchImpl: fetchMock },
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    );
  });

  it('Base URL 指向任意外部主机 → 400 拒绝，不发起请求（SSRF）', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const res = await handleArkRequest(
      makeRequest(openaiBody({ baseUrl: 'https://evil.example.com/v1' })),
      { fetchImpl: fetchMock },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errorClass).toBe('illegal-endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('http（非 https）Base URL → 400 拒绝', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const res = await handleArkRequest(
      makeRequest(openaiBody({ baseUrl: 'http://ark.cn-beijing.volces.com/api/plan/v3' })),
      { fetchImpl: fetchMock },
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Endpoint 填 URL → 400；缺少 Key → 400；空 messages → 400', async () => {
    const f1 = vi.fn<typeof fetch>();
    const r1 = await handleArkRequest(makeRequest(openaiBody({ model: 'https://evil/x' })), { fetchImpl: f1 });
    expect(r1.status).toBe(400);
    expect(f1).not.toHaveBeenCalled();

    const f2 = vi.fn<typeof fetch>();
    const r2 = await handleArkRequest(makeRequest(openaiBody(), null), { fetchImpl: f2 });
    expect(r2.status).toBe(400);
    expect((await r2.json()).errorClass).toBe('not-configured');

    const f3 = vi.fn<typeof fetch>();
    const r3 = await handleArkRequest(makeRequest(openaiBody({ messages: [] })), { fetchImpl: f3 });
    expect(r3.status).toBe(400);
    expect(f3).not.toHaveBeenCalled();
  });
});

describe('arkProxy Anthropic 协议', () => {
  it('转换请求体/鉴权头，解析 Anthropic 响应并归一化 Token', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            type: 'message',
            request_id: 'req-a1',
            content: [{ type: 'text', text: '{"hello":1}' }],
            usage: { input_tokens: 12, output_tokens: 7 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const res = await handleArkRequest(
      makeRequest({
        protocol: 'anthropic',
        baseUrl: ARK_DEFAULT_BASE_URLS.anthropic,
        model: 'ep-anth-001',
        messages: [
          { role: 'system', content: 'SYS' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
              { type: 'image_url', image_url: { url: 'https://evil.com/x.png' } }, // 外部图片 URL 必须被丢弃
            ],
          },
        ],
      }),
      { fetchImpl: fetchMock },
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe('{"hello":1}');
    expect(data.diagnostics.totalTokens).toBe(19);

    expect(String(fetchMock.mock.calls[0][0])).toBe(ANTHROPIC_URL);
    const init = fetchMock.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(SECRET);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('SYS');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.response_format).toBeUndefined();
    const blocks = body.messages[0].content;
    expect(blocks.some((b: any) => b.type === 'image' && b.source.data === 'QUJD')).toBe(true);
    // 不允许服务端抓取的外部图片 URL 被转发
    expect(JSON.stringify(body)).not.toContain('https://evil.com/x.png');
  });
});

describe('arkProxy 出站 messages 深度净化', () => {
  it('OpenAI 路径同样剥离外部图片 URL、未知 part 与消息级多余字段', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => openaiSuccess());
    await handleArkRequest(
      makeRequest(
        openaiBody({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '看图' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
                // 外部 URL：禁止服务端回源（SSRF），必须深度丢弃
                { type: 'image_url', image_url: { url: 'https://evil.com/x.png' }, detail: 'high' },
                // 伪装成图片的 SVG/脚本载体
                { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } },
                // 工具调用等未知 part
                { type: 'tool_use', id: 't1', name: 'shell', input: { cmd: 'id' } },
              ],
              // 消息级注入字段不得转发
              tool_calls: [{ id: 'x' }],
            },
          ],
        }),
      ),
      { fetchImpl: fetchMock },
    );

    const forwarded = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const content = forwarded.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: '看图' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,QUJD' },
    });
    expect(forwarded.messages[0].tool_calls).toBeUndefined();
    expect(JSON.stringify(forwarded)).not.toContain('https://evil.com/x.png');
    expect(JSON.stringify(forwarded)).not.toContain('image/svg+xml');
    expect(JSON.stringify(forwarded)).not.toContain('tool_use');
  });

  it('净化后无任何合法内容 → 400，不发请求；但字符串文本消息永远可用', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const res = await handleArkRequest(
      makeRequest(
        openaiBody({
          messages: [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://evil.com/x.png' } }] },
          ],
        }),
      ),
      { fetchImpl: fetchMock },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errorClass).toBe('bad-request');
    expect(fetchMock).not.toHaveBeenCalled();

    const okMock = vi.fn<typeof fetch>(async () => openaiSuccess());
    const okRes = await handleArkRequest(makeRequest(openaiBody()), { fetchImpl: okMock });
    expect(okRes.status).toBe(200);
  });
});

describe('arkProxy 上游失败/超时/非法响应', () => {
  it('401 归类 invalid-key', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
    );
    const res = await handleArkRequest(makeRequest(openaiBody()), { fetchImpl: fetchMock });
    expect(res.status).toBe(401);
    expect((await res.json()).errorClass).toBe('invalid-key');
  });

  it('上游错误回显 Key 必须脱敏，响应不含 Key', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: { message: `bad Bearer ${SECRET}` } }),
          { status: 500 },
        ),
    );
    const res = await handleArkRequest(makeRequest(openaiBody()), { fetchImpl: fetchMock });
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED]');
    expect(res.status).toBe(502);
  });

  it('超时 → 504 timeout；网络错误 → 502 network；200 非 JSON → 502', async () => {
    const timeoutMock = vi.fn<typeof fetch>(
      (_i, init) =>
        new Promise((_r, reject) => {
          init!.signal!.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    const r1 = await handleArkRequest(makeRequest(openaiBody()), {
      fetchImpl: timeoutMock,
      timeoutMs: 20,
    });
    expect(r1.status).toBe(504);
    expect((await r1.json()).errorClass).toBe('timeout');

    const netMock = vi.fn<typeof fetch>(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r2 = await handleArkRequest(makeRequest(openaiBody()), { fetchImpl: netMock });
    expect(r2.status).toBe(502);
    expect((await r2.json()).errorClass).toBe('network');

    const badMock = vi.fn<typeof fetch>(async () => new Response('oops', { status: 200 }));
    const r3 = await handleArkRequest(makeRequest(openaiBody()), { fetchImpl: badMock });
    expect(r3.status).toBe(502);
  });

  it('诊断回调只收到脱敏字段，不含 Key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => openaiSuccess());
    const onDiagnostic = vi.fn();
    await handleArkRequest(makeRequest(openaiBody()), { fetchImpl: fetchMock, onDiagnostic });
    expect(onDiagnostic).toHaveBeenCalled();
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain(SECRET);
  });
});

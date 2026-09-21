import { describe, expect, it, vi } from 'vitest';
import { handleArkImageRequest } from './arkImageProxy';
import { IMAGES_PROXY_PATH } from '../shared/constants';

const KEY = 'ark-image-secret';

function makeRequest(body: unknown, key = KEY): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers['x-ark-api-key'] = key;
  return new Request(`http://local.invalid${IMAGES_PROXY_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function jsonFetch(responseBody: unknown, status = 200, ok = status < 400) {
  return vi.fn(async () => ({
    ok,
    status,
    headers: { get: () => 'req-1' },
    text: async () => JSON.stringify(responseBody),
  })) as unknown as typeof fetch;
}

describe('arkImageProxy', () => {
  it('缺少 Key → not-configured', async () => {
    const res = await handleArkImageRequest(makeRequest({}, ''));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.errorClass).toBe('not-configured');
  });

  it('图片 Endpoint 为 URL → illegal-endpoint', async () => {
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'https://evil.com/x', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', prompt: 'p' }),
    );
    const j = await res.json();
    expect(res.status).toBe(400);
    expect(j.errorClass).toBe('illegal-endpoint');
  });

  it('OpenAI 协议下任意外部主机 Base URL 被拒绝', async () => {
    const fetchMock = vi.fn();
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'ep-img', protocol: 'openai', imageBaseUrl: 'https://evil.example.com/v1', prompt: 'p' }),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const j = await res.json();
    expect(j.errorClass).toBe('illegal-endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('图片生成独立使用 Platform OpenAI 基址，请求体只含白名单字段并强制 b64_json', async () => {
    let captured: { url: string; body: any; headers: any } | null = null;
    const fetchMock = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'rid' },
        text: async () => JSON.stringify({ data: [{ b64_json: 'QUJD' }] }),
      };
    }) as unknown as typeof fetch;
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'ep-img', protocol: 'anthropic', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan', prompt: '画一个杯子' }),
      { fetchImpl: fetchMock },
    );
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.b64Json).toBe('QUJD');
    expect(captured!.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    expect(captured!.body.response_format).toBe('b64_json');
    expect(captured!.body.model).toBe('ep-img');
    expect(captured!.body.prompt).toContain('杯子');
    // 不得透传任意额外参数
    expect(captured!.body.api_key).toBeUndefined();
    expect(captured!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('安全转发商品参考图、尺寸和组图数量，并返回全部 base64 图片', async () => {
    let captured: any;
    const fetchMock = (async (_url: unknown, init: any) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'rid' },
        text: async () =>
          JSON.stringify({ data: [{ b64_json: 'QUFB' }, { b64_json: 'QkJC' }] }),
      };
    }) as unknown as typeof fetch;
    const image = 'data:image/png;base64,QUJD';
    const res = await handleArkImageRequest(
      makeRequest({
        imageEndpoint: 'ep-img',
        protocol: 'openai',
        imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        prompt: '保持商品主体，生成场景图',
        images: [image, 'https://evil.example.com/product.png'],
        size: '1728x2304',
        count: 2,
      }),
      { fetchImpl: fetchMock },
    );
    const body = await res.json();
    expect(captured.image).toEqual([image]);
    expect(captured.size).toBe('1728x2304');
    expect(captured.sequential_image_generation).toBe('auto');
    expect(captured.sequential_image_generation_options).toEqual({ max_images: 2 });
    expect(captured.output_format).toBe('png');
    expect(captured.response_format).toBe('b64_json');
    expect(captured.watermark).toBe(false);
    expect(captured).not.toHaveProperty('seed');
    expect(body.images).toHaveLength(2);
    expect(body.b64Json).toBe('QUFB');
  });

  it('上游只返回外部 URL 而无 b64_json 时拒绝（不跟随 URL）', async () => {
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'ep-img', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', prompt: 'p' }),
      { fetchImpl: jsonFetch({ data: [{ url: 'https://cdn.example.com/a.png' }] }) },
    );
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.message).toContain('b64_json');
  });

  it('上游 401 归类 invalid-key', async () => {
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'ep-img', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', prompt: 'p' }),
      { fetchImpl: jsonFetch({ error: { message: 'The API key or AK/SK in the request is missing or invalid. Request id: abc123' } }, 401, false) },
    );
    const j = await res.json();
    expect(j.errorClass).toBe('invalid-key');
    expect(j.message).toMatch(/API Key 管理/);
    expect(j.message).not.toMatch(/Request id/);
    expect(j.diagnostics.requestId).toBe('abc123');
  });

  it('上游中断归类 timeout（504）', async () => {
    const fetchMock = (async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'ep-img', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', prompt: 'p', timeoutMs: 6000 }),
      { fetchImpl: fetchMock },
    );
    const j = await res.json();
    expect(res.status).toBe(504);
    expect(j.errorClass).toBe('timeout');
  });

  it('上游 fetch failed 会重试一次，并展开 cause 错误码', async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      const err = new Error('fetch failed');
      (err as Error & { cause?: unknown }).cause = Object.assign(new Error('Connect Timeout Error'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      });
      throw err;
    }) as unknown as typeof fetch;
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'ep-img', protocol: 'openai', imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', prompt: 'p' }),
      { fetchImpl: fetchMock },
    );
    const j = await res.json();
    expect(calls).toBe(2);
    expect(j.errorClass).toBe('network');
    expect(j.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(j.message).not.toContain(KEY);
  });

  it('第一次网络失败后重试成功则返回图片', async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'rid' },
        text: async () => JSON.stringify({ data: [{ b64_json: 'QUJD' }] }),
      };
    }) as unknown as typeof fetch;
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'ep-img', protocol: 'openai', imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', prompt: '画一个杯子' }),
      { fetchImpl: fetchMock },
    );
    const j = await res.json();
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
    expect(j.b64Json).toBe('QUJD');
  });

  it('响应与错误均不含 Key', async () => {
    const res = await handleArkImageRequest(
      makeRequest({ imageEndpoint: 'ep-img', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', prompt: 'p' }),
      { fetchImpl: jsonFetch({ error: { message: `leak ${KEY}` } }, 500, false) },
    );
    const text = await res.text();
    expect(text).not.toContain(KEY);
  });
});

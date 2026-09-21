import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateImage } from './arkClient';
import { IMAGES_PROXY_PATH } from '../shared/constants';
import type { ModelSettings } from '../shared/types';

const SECRET = 'sk-img-secret-9999';
const SETTINGS: ModelSettings = {
  apiKey: SECRET,
  seedEndpoint: 'ep-seed',
  imageEndpoint: 'ep-seedream',
  imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  protocol: 'openai',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateImage client', () => {
  it('未配置 settings → not-configured', async () => {
    const r = await generateImage(null, 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorClass).toBe('not-configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缺少图片 Endpoint → not-configured 且不发请求', async () => {
    const r = await generateImage({ ...SETTINGS, imageEndpoint: '' }, 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('图片生成 Endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('图片 Endpoint 为 URL → illegal-endpoint', async () => {
    const r = await generateImage({ ...SETTINGS, imageEndpoint: 'https://x.com/a' }, 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorClass).toBe('illegal-endpoint');
  });

  it('成功：走 /api/ark/images，Key 只在头，prompt 原样下发，返回 b64', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, b64Json: 'QUJD', mediaType: 'image/png', diagnostics: {} }),
    });
    const folded = '正向提示\n\n避免：红字';
    const r = await generateImage(SETTINGS, folded, { timeoutMs: 6000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.b64Json).toBe('QUJD');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(IMAGES_PROXY_PATH);
    expect(init.headers['x-ark-api-key']).toBe(SECRET);
    const body = JSON.parse(init.body);
    expect(body.imageEndpoint).toBe('ep-seedream');
    expect(body.prompt).toContain('正向提示');
    expect(body.prompt).toContain('避免：红字');
    // Key 不进 URL/体
    expect(init.body).not.toContain(SECRET);
    expect(String(url)).not.toContain(SECRET);
  });

  it('图片请求使用 imageApiKey，不用文本通道的 Key', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, b64Json: 'QUJD', mediaType: 'image/png', diagnostics: {} }),
    });
    const imageKey = 'sk-image-only-1111';
    await generateImage(
      {
        ...SETTINGS,
        apiKey: 'sk-should-not-use',
        imageApiKey: imageKey,
        textApiKey: 'sk-text-only-2222',
      },
      'p',
    );
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['x-ark-api-key']).toBe(imageKey);
    expect(init.body).not.toContain(imageKey);
    expect(init.body).not.toContain('sk-text-only-2222');
  });

  it('代理返回业务错误时透传 errorClass', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, errorClass: 'server', message: '未返回 b64_json' }),
    });
    const r = await generateImage(SETTINGS, 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorClass).toBe('server');
  });

  it('商品图、官方尺寸与数量进入安全代理请求，并解析多图', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        b64Json: 'QUFB',
        mediaType: 'image/png',
        images: [
          { b64Json: 'QUFB', mediaType: 'image/png' },
          { b64Json: 'QkJC', mediaType: 'image/png' },
        ],
        diagnostics: {},
      }),
    });
    const r = await generateImage(SETTINGS, '商品场景图', {
      size: '1728x2304',
      count: 2,
      productImages: [
        {
          id: 'p1',
          name: 'product.png',
          mediaType: 'image/png',
          dataUri: 'data:image/png;base64,QUJD',
        },
      ],
    });
    expect(r.ok && r.images).toHaveLength(2);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      size: '1728x2304',
      count: 2,
      images: ['data:image/png;base64,QUJD'],
    });
  });

  it('未保存 imageBaseUrl 时回落到 Platform 图片基址', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, b64Json: 'QUJD', mediaType: 'image/png', diagnostics: {} }),
    });
    await generateImage({ ...SETTINGS, imageBaseUrl: undefined }, 'p');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.imageBaseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
  });
});

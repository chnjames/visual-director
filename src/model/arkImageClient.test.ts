import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateImage } from './arkClient';
import { buildArkImageUrl } from '../shared/constants';
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

  it('成功：直接请求图片 Base URL，Key 只在鉴权头，prompt 原样下发', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: 'QUJD' }] }),
    });
    const folded = '正向提示\n\n避免：红字';
    const r = await generateImage(SETTINGS, folded, { timeoutMs: 6000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.b64Json).toBe('QUJD');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(buildArkImageUrl(SETTINGS.imageBaseUrl!));
    expect(init.headers.authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('ep-seedream');
    expect(body.prompt).toContain('正向提示');
    expect(body.prompt).toContain('避免：红字');
    expect(body.response_format).toBe('b64_json');
    expect(init.body).not.toContain(SECRET);
    expect(String(url)).not.toContain(SECRET);
  });

  it('图片请求使用 imageApiKey，不用文本通道的 Key', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: 'QUJD' }] }),
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
    expect(init.headers.authorization).toBe(`Bearer ${imageKey}`);
    expect(init.body).not.toContain(imageKey);
    expect(init.body).not.toContain('sk-text-only-2222');
  });

  it('上游错误按 HTTP 状态分类', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: { message: '未返回 b64_json' } }),
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
        data: [{ b64_json: 'QUFB' }, { b64_json: 'QkJC' }],
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
    expect(String(fetchMock.mock.calls[0][0])).toBe(buildArkImageUrl(SETTINGS.imageBaseUrl!));
    expect(body).toMatchObject({
      model: 'ep-seedream',
      size: '1728x2304',
      image: ['data:image/png;base64,QUJD'],
      sequential_image_generation: 'auto',
      sequential_image_generation_options: { max_images: 2 },
    });
  });

  it('未保存 imageBaseUrl 时回落到 Platform 图片基址', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: 'QUJD' }] }),
    });
    await generateImage({ ...SETTINGS, imageBaseUrl: undefined }, 'p');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      buildArkImageUrl('https://ark.cn-beijing.volces.com/api/v3'),
    );
  });
});

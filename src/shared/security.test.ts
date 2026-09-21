import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveModelSettings,
  loadModelSettings,
  clearModelSettings,
  hasConfiguredKey,
  maskApiKey,
  maskEndpoint,
  redactSecret,
  describeNetworkFailure,
  localizeUpstreamError,
  isSecretPersisted,
  isValidEndpoint,
  isValidBaseUrl,
  classifyHttpStatus,
  buildSafeDiagnostics,
} from './security';
import { ARK_DEFAULT_BASE_URLS, clampTimeoutMs, ARK_MIN_TIMEOUT_MS, ARK_MAX_TIMEOUT_MS, ARK_REQUEST_TIMEOUT_MS } from './constants';

const SECRET = 'sk-secret-ABCDEF123456';
const SETTINGS = {
  apiKey: SECRET,
  seedEndpoint: 'ep-2024test-abcde',
  imageEndpoint: 'ep-image-abcde',
  protocol: 'openai' as const,
  baseUrl: ARK_DEFAULT_BASE_URLS.openai,
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  clearModelSettings();
});

describe('Key 仅存于 sessionStorage', () => {
  it('保存后可从 sessionStorage 读取，且不进入 localStorage / cookie', () => {
    saveModelSettings(SETTINGS);
    expect(hasConfiguredKey()).toBe(true);
    expect(loadModelSettings()?.apiKey).toBe(SECRET);

    // sessionStorage 中确实有
    const inSession = Object.values(sessionStorage).some((v) => v.includes(SECRET));
    expect(inSession).toBe(true);

    // localStorage 不得出现 Key / Endpoint
    let inLocal = false;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i) as string;
      if ((localStorage.getItem(k) ?? '').includes(SECRET)) inLocal = true;
    }
    expect(inLocal).toBe(false);
    expect(document.cookie).not.toContain(SECRET);

    const leak = isSecretPersisted(SECRET);
    expect(leak.inLocalStorage).toBe(false);
    expect(leak.inCookie).toBe(false);
  });

  it('泄漏检查器确实能发现进入 localStorage 的密钥（自检）', () => {
    localStorage.setItem('bad-leak', JSON.stringify({ key: SECRET }));
    expect(isSecretPersisted(SECRET).inLocalStorage).toBe(true);
  });

  it('清除/断开后 sessionStorage 不再保留', () => {
    saveModelSettings(SETTINGS);
    clearModelSettings();
    expect(loadModelSettings()).toBeNull();
    expect(hasConfiguredKey()).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('脱敏', () => {
  it('maskApiKey 不泄露完整 Key，仅保留末位', () => {
    const masked = maskApiKey(SECRET);
    expect(masked).not.toContain(SECRET);
    expect(masked).toContain('•');
  });
  it('maskEndpoint 隐藏中间部分', () => {
    expect(maskEndpoint('ep-2024test-abcde')).not.toBe('ep-2024test-abcde');
  });
  it('redactSecret 能把任意文本中的密钥替换掉', () => {
    const text = `error for Bearer ${SECRET} denied`;
    expect(redactSecret(text, SECRET)).not.toContain(SECRET);
    expect(redactSecret(text, SECRET)).toContain('[REDACTED]');
  });
  it('describeNetworkFailure 展开 fetch failed 的 cause 错误码', () => {
    const err = new Error('fetch failed');
    (err as Error & { cause?: unknown }).cause = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const text = describeNetworkFailure(err);
    expect(text).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(text).toContain('fetch failed');
  });
  it('localizeUpstreamError 把 401 收成中文，并抽出 Request id', () => {
    const r = localizeUpstreamError(
      'invalid-key',
      'The API key or AK/SK in the request is missing or invalid. Request id: 0217899203649932abc',
    );
    expect(r.message).toMatch(/API Key 管理/);
    expect(r.message).not.toMatch(/Request id/);
    expect(r.requestId).toBe('0217899203649932abc');
  });
  it('buildSafeDiagnostics 只保留白名单字段，剥离任意额外（含密钥）字段', () => {
    const d = buildSafeDiagnostics({
      model: 'ep-x',
      // @ts-expect-error 故意传入越权字段
      apiKey: SECRET,
      authorization: `Bearer ${SECRET}`,
      httpStatus: 200,
    });
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect((d as any).apiKey).toBeUndefined();
    expect((d as any).authorization).toBeUndefined();
  });
});

describe('Endpoint 白名单（防任意地址）', () => {
  it('接受普通接入点/模型 ID', () => {
    expect(isValidEndpoint('ep-20240901-abcde')).toBe(true);
    expect(isValidEndpoint('doubao-seed-1-6-250615')).toBe(true);
    expect(isValidEndpoint('doubao-seedream-5-0-260128')).toBe(true);
  });

  it('只配置图片模型也视为已连接', () => {
    saveModelSettings({
      apiKey: SECRET,
      seedEndpoint: '',
      imageEndpoint: 'doubao-seedream-5-0-260128',
      protocol: 'openai',
      baseUrl: ARK_DEFAULT_BASE_URLS.openai,
    });
    expect(hasConfiguredKey()).toBe(true);
    expect(loadModelSettings()?.imageBaseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(loadModelSettings()?.imageApiKey).toBe(SECRET);
    expect(loadModelSettings()?.textApiKey).toBe(SECRET);
  });

  it('旧的一把 apiKey 会同时填入图片和文本通道', () => {
    sessionStorage.setItem(
      'vrp.modelSettings.v1',
      JSON.stringify({ apiKey: SECRET, seedEndpoint: 'ep-x', imageEndpoint: 'ep-img' }),
    );
    const loaded = loadModelSettings();
    expect(loaded?.imageApiKey).toBe(SECRET);
    expect(loaded?.textApiKey).toBe(SECRET);
    expect(loaded?.apiKey).toBe(SECRET);
  });

  it('图片和文本可以保存不同的 Key', () => {
    saveModelSettings({
      apiKey: 'sk-image',
      imageApiKey: 'sk-image',
      textApiKey: 'sk-text',
      seedEndpoint: 'ep-text',
      imageEndpoint: 'doubao-seedream-5-0-260128',
      protocol: 'openai',
      baseUrl: ARK_DEFAULT_BASE_URLS.openai,
    });
    const loaded = loadModelSettings();
    expect(loaded?.imageApiKey).toBe('sk-image');
    expect(loaded?.textApiKey).toBe('sk-text');
    expect(loaded?.apiKey).toBe('sk-image');
    expect(hasConfiguredKey()).toBe(true);
  });
  it('拒绝 URL、路径、协议、空值', () => {
    expect(isValidEndpoint('https://evil.example.com/v1')).toBe(false);
    expect(isValidEndpoint('http://ark.cn-beijing.volces.com')).toBe(false);
    expect(isValidEndpoint('ep-x/../../etc')).toBe(false);
    expect(isValidEndpoint('ep-x?a=1')).toBe(false);
    expect(isValidEndpoint('')).toBe(false);
  });
});

describe('超时分级与钳制', () => {
  it('合法值原样返回，越界/非法值被钳制或回落', () => {
    expect(clampTimeoutMs(30000)).toBe(30000);
    expect(clampTimeoutMs(1)).toBe(ARK_MIN_TIMEOUT_MS);
    expect(clampTimeoutMs(9_999_999)).toBe(ARK_MAX_TIMEOUT_MS);
    expect(clampTimeoutMs('abc')).toBe(ARK_REQUEST_TIMEOUT_MS);
    expect(clampTimeoutMs(undefined)).toBe(ARK_REQUEST_TIMEOUT_MS);
  });
});

describe('Base URL 可修改但限官方域名（SSRF 防护）', () => {
  it('接受两种协议默认地址', () => {
    expect(isValidBaseUrl(ARK_DEFAULT_BASE_URLS.openai)).toBe(true);
    expect(isValidBaseUrl(ARK_DEFAULT_BASE_URLS.anthropic)).toBe(true);
  });
  it('接受在官方域名下修改路径', () => {
    expect(isValidBaseUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(true);
    expect(isValidBaseUrl('https://ark.cn-beijing.volces.com/api/plan/v3/')).toBe(true);
  });
  it('拒绝任意外部主机、http、带凭据/查询串', () => {
    expect(isValidBaseUrl('https://evil.example.com/v1')).toBe(false);
    expect(isValidBaseUrl('http://ark.cn-beijing.volces.com/api/plan/v3')).toBe(false);
    expect(isValidBaseUrl('https://ark.cn-beijing.volces.com.evil.com/x')).toBe(false);
    expect(isValidBaseUrl('https://user:pass@ark.cn-beijing.volces.com')).toBe(false);
    expect(isValidBaseUrl('https://ark.cn-beijing.volces.com/x?apiKey=1')).toBe(false);
    expect(isValidBaseUrl('not a url')).toBe(false);
    expect(isValidBaseUrl('')).toBe(false);
  });
  it('拒绝官方后缀的前缀仿冒域名（evilvolces.com 等 SSRF 绕过）', () => {
    // 裸后缀 endsWith 的经典绕过：同后缀前缀的攻击者域名
    expect(isValidBaseUrl('https://evilvolces.com/x')).toBe(false);
    expect(isValidBaseUrl('https://notvolces.com/x')).toBe(false);
    expect(isValidBaseUrl('https://volces.com.evil.io/x')).toBe(false);
    // 大小写归一化后仍须拒绝
    expect(isValidBaseUrl('https://EVILVOLCES.COM/x')).toBe(false);
    // 官方根域本身允许，任意层级子域允许
    expect(isValidBaseUrl('https://volces.com/')).toBe(true);
    expect(isValidBaseUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(true);
  });
  it('旧设置（缺 protocol/baseUrl）加载时自动补默认值', () => {
    sessionStorage.setItem(
      'vrp.modelSettings.v1',
      JSON.stringify({ apiKey: SECRET, seedEndpoint: 'ep-x' }),
    );
    const m = loadModelSettings();
    expect(m?.protocol).toBe('openai');
    expect(m?.baseUrl).toBe(ARK_DEFAULT_BASE_URLS.openai);
  });
});

describe('HTTP 状态分类', () => {
  it('401/403→invalid-key，404→endpoint-not-found，429→quota，5xx→server', () => {
    expect(classifyHttpStatus(401)).toBe('invalid-key');
    expect(classifyHttpStatus(403)).toBe('invalid-key');
    expect(classifyHttpStatus(404)).toBe('endpoint-not-found');
    expect(classifyHttpStatus(429)).toBe('quota');
    expect(classifyHttpStatus(500)).toBe('server');
    expect(classifyHttpStatus(400)).toBe('bad-request');
  });
});

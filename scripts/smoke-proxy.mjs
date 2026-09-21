/**
 * 本地冒烟检查（不使用测试框架，直接对运行中的服务器发真实 HTTP 请求）。
 * 用法：node scripts/smoke-proxy.mjs [baseUrl]
 * 验证：静态首页、无 Key 拦截、非法 Endpoint/Base URL 拦截、
 *      OpenAI 与 Anthropic 两种协议到达【固定官方域名】的真实转发（假 Key，预期鉴权失败），
 *      并断言任何响应都不回显 Key。
 */
const base = process.argv[2] || 'http://localhost:5173';
const SECRET = 'sk-smoke-secret-ZZZ-NOREALKEY';
const PROXY = `${base}/api/ark/chat`;
const IMAGES = `${base}/api/ark/images`;
const OPENAI_BASE = 'https://ark.cn-beijing.volces.com/api/plan/v3';
const ANTHROPIC_BASE = 'https://ark.cn-beijing.volces.com/api/plan';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ` :: ${extra}` : ''}`);
  if (!cond) failures += 1;
}
async function post(body, key = SECRET, route = PROXY) {
  const headers = { 'content-type': 'application/json' };
  if (key !== null) headers['x-ark-api-key'] = key;
  return fetch(route, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function main() {
  const home = await fetch(base, { method: 'GET' });
  const html = await home.text();
  check('首页可打开且包含挂载点', home.status === 200 && html.includes('id="root"'), `status=${home.status}`);

  const noKey = await post(
    { protocol: 'openai', baseUrl: OPENAI_BASE, model: 'ep-x', messages: [{ role: 'user', content: 'ping' }] },
    null,
  );
  const noKeyJson = await noKey.json().catch(() => null);
  check('无 Key → 400 not-configured', noKey.status === 400 && noKeyJson?.errorClass === 'not-configured',
    `status=${noKey.status} class=${noKeyJson?.errorClass}`);

  const evilEndpoint = await post({
    protocol: 'openai', baseUrl: OPENAI_BASE,
    model: 'https://evil.example.com/v1', messages: [{ role: 'user', content: 'ping' }],
  });
  const evilEndpointJson = await evilEndpoint.json().catch(() => null);
  check('URL 形态 Endpoint → 400', evilEndpoint.status === 400 && evilEndpointJson?.errorClass === 'illegal-endpoint',
    `status=${evilEndpoint.status}`);
  check('拦截响应不回显 Key', JSON.stringify(evilEndpointJson).includes(SECRET) === false);

  const evilBase = await post({
    protocol: 'openai', baseUrl: 'https://evil.example.com/v1',
    model: 'ep-x', messages: [{ role: 'user', content: 'ping' }],
  });
  const evilBaseJson = await evilBase.json().catch(() => null);
  check('任意外部主机 Base URL → 400（SSRF 拦截）', evilBase.status === 400 && evilBaseJson?.errorClass === 'illegal-endpoint',
    `status=${evilBase.status} class=${evilBaseJson?.errorClass}`);

  // 官方后缀的前缀仿冒（裸后缀 endsWith 绕过）：evilvolces.com 必须同样被拒
  const spoofBase = await post({
    protocol: 'openai', baseUrl: 'https://evilvolces.com/v1',
    model: 'ep-x', messages: [{ role: 'user', content: 'ping' }],
  });
  const spoofJson = await spoofBase.json().catch(() => null);
  check('前缀仿冒域名 evilvolces.com → 400（SSRF 点边界）',
    spoofBase.status === 400 && spoofJson?.errorClass === 'illegal-endpoint',
    `status=${spoofBase.status} class=${spoofJson?.errorClass}`);

  // OpenAI 协议真实转发（假 Key，预期非 2xx）
  const openai = await post({
    protocol: 'openai', baseUrl: OPENAI_BASE,
    model: 'ep-smoke-nonexistent-0000', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1,
  });
  const openaiText = await openai.text();
  let openaiJson = null;
  try { openaiJson = JSON.parse(openaiText); } catch { /* ignore */ }
  check('OpenAI 真实转发被安全分类（不伪装成功）', [400, 401, 403, 404, 429, 500, 502, 504].includes(openai.status) && openaiJson?.ok !== true,
    `status=${openai.status} class=${openaiJson?.errorClass ?? 'n/a'}`);
  check('OpenAI 响应不回显 Key', !openaiText.includes(SECRET));

  // Anthropic 协议真实转发（假 Key，预期非 2xx）
  const anth = await post({
    protocol: 'anthropic', baseUrl: ANTHROPIC_BASE,
    model: 'ep-smoke-nonexistent-0000', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1,
  });
  const anthText = await anth.text();
  let anthJson = null;
  try { anthJson = JSON.parse(anthText); } catch { /* ignore */ }
  check('Anthropic 真实转发被安全分类（不伪装成功）', [400, 401, 403, 404, 429, 500, 502, 504].includes(anth.status) && anthJson?.ok !== true,
    `status=${anth.status} class=${anthJson?.errorClass ?? 'n/a'}`);
  check('Anthropic 响应不回显 Key', !anthText.includes(SECRET));

  // ---- 图片生成路由（阶段2） ----
  const imgNoKey = await post(
    { protocol: 'openai', baseUrl: OPENAI_BASE, imageEndpoint: 'ep-img', prompt: 'p' },
    null,
    IMAGES,
  );
  const imgNoKeyJson = await imgNoKey.json().catch(() => null);
  check('图片路由无 Key → 400 not-configured', imgNoKey.status === 400 && imgNoKeyJson?.errorClass === 'not-configured',
    `status=${imgNoKey.status} class=${imgNoKeyJson?.errorClass}`);

  const imgEvil = await post(
    { protocol: 'openai', baseUrl: OPENAI_BASE, imageEndpoint: 'https://evil.example.com/x', prompt: 'p' },
    SECRET,
    IMAGES,
  );
  const imgEvilJson = await imgEvil.json().catch(() => null);
  check('图片 Endpoint 为 URL → 400', imgEvil.status === 400 && imgEvilJson?.errorClass === 'illegal-endpoint',
    `status=${imgEvil.status}`);

  const imgEvilBase = await post(
    { protocol: 'openai', baseUrl: 'https://evil.example.com/v1', imageEndpoint: 'ep-img', prompt: 'p' },
    SECRET,
    IMAGES,
  );
  const imgEvilBaseJson = await imgEvilBase.json().catch(() => null);
  check('图片路由任意外部主机 → 400（SSRF）', imgEvilBase.status === 400 && imgEvilBaseJson?.errorClass === 'illegal-endpoint',
    `status=${imgEvilBase.status}`);

  // Anthropic 协议下图片请求应改用 OpenAI 基址并真实转发（假 Key，预期非 2xx，不伪装成功）
  const imgAnth = await post(
    { protocol: 'anthropic', baseUrl: ANTHROPIC_BASE, imageEndpoint: 'ep-smoke-nonexistent-0000', prompt: '一个白色杯子' },
    SECRET,
    IMAGES,
  );
  const imgAnthText = await imgAnth.text();
  let imgAnthJson = null;
  try { imgAnthJson = JSON.parse(imgAnthText); } catch { /* ignore */ }
  check('图片请求真实转发被安全分类（不伪装成功）', [400, 401, 403, 404, 429, 500, 502, 504].includes(imgAnth.status) && imgAnthJson?.ok !== true,
    `status=${imgAnth.status} class=${imgAnthJson?.errorClass ?? 'n/a'}`);
  check('图片响应不回显 Key', !imgAnthText.includes(SECRET));

  console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error('SMOKE ERROR', e);
  process.exit(1);
});

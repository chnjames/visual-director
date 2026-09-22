/**
 * 部署环境与模型请求传输层。
 *
 * 当前架构：
 * - 浏览器通过 CORS 直连火山方舟 Platform API（火山对任意 Origin 反射放行），
 *   API Key 只保存在 sessionStorage。
 * - 托管到 Vercel 时，构建期注入 VITE_USE_SERVER_PROXY=1，模型请求自动改走
 *   同源 Serverless 函数（/api/ark/chat、/api/ark/images），避免依赖用户
 *   浏览器到火山接口的网络连通性。
 *
 * 同源代理的请求体契约与 src/server/arkProxy.ts、arkImageProxy.ts 一致；
 * API Key 通过 x-ark-api-key 头传递，不进 URL / 日志。
 */
import { IMAGES_PROXY_PATH, PROXY_PATH } from '../shared/constants';
import { API_KEY_HEADER } from '../server/arkProxy';

/** 是否走同源 Serverless 代理（仅 Vercel 构建注入）。 */
export const USE_SERVER_PROXY =
  ((import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_USE_SERVER_PROXY ?? '').toString() === '1';

export type ArkChatProxyBody = {
  protocol?: string;
  baseUrl?: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  response_format?: unknown;
  timeoutMs?: number;
};

export type ArkImageProxyBody = {
  imageBaseUrl?: string;
  imageEndpoint: string;
  prompt: string;
  images?: string[];
  count?: number;
  size?: string;
  timeoutMs?: number;
};

/** 调用同源文本/视觉理解函数。 */
export function fetchArkChatProxy(
  apiKey: string,
  body: ArkChatProxyBody,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(PROXY_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      [API_KEY_HEADER]: apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** 调用同源图片生成函数。 */
export function fetchArkImagesProxy(
  apiKey: string,
  body: ArkImageProxyBody,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(IMAGES_PROXY_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      [API_KEY_HEADER]: apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });
}

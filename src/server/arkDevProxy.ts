/// <reference types="node" />
/**
 * 将同构代理处理器挂载到 Vite 开发服务器（Connect 中间件）。
 * 同时挂载对话代理 /api/ark/chat 与图片代理 /api/ark/images。
 * 仅在本地开发时生效；生产环境可用 server/proxy-server.mjs。
 */
import type { Plugin } from 'vite';
import { IMAGES_PROXY_PATH, PROXY_PATH } from '../shared/constants';
import { handleArkRequest } from './arkProxy';
import { handleArkImageRequest } from './arkImageProxy';

export function arkDevProxyPlugin(): Plugin {
  return {
    name: 'visual-recipe-ark-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        const pathname = url.split('?')[0];
        const isChat = pathname.endsWith(PROXY_PATH);
        const isImages = pathname.endsWith(IMAGES_PROXY_PATH);
        if (!isChat && !isImages) {
          return next();
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          const bodyBuf = Buffer.concat(chunks);

          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(','));
          }

          const request = new Request(`http://localhost${pathname}`, {
            method: req.method,
            headers,
            body: bodyBuf,
          });

          const response = isImages
            ? await handleArkImageRequest(request)
            : await handleArkRequest(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          const out = Buffer.from(await response.arrayBuffer());
          res.end(out);
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          // 兜底错误同样不得包含内部细节或密钥
          res.end(
            JSON.stringify({
              ok: false,
              errorClass: 'server',
              message: '代理内部错误',
              diagnostics: { model: '(none)', endpointMasked: '(none)' },
            }),
          );
        }
      });
    },
  };
}

/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { arkDevProxyPlugin } from './src/server/arkDevProxy';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), arkDevProxyPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // 代理处理器测试使用 Node 原生 fetch/Request/Response，jsdom 下同样可用
    pool: 'forks',
  },
} as any);

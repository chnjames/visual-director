/**
 * 零依赖 hash 路由（docs/11 §2）。
 * 选择 hash 而非 History API：自部署静态服务器与无后端 fallback 都可直接刷新，
 * 不新增 react-router 依赖（符合“简单、可直接运行”的工程约束）。
 *
 * 路由：
 *   /                                     产品官网首页（Landing，docs/16）
 *   /projects                             项目首页（工作台）
 *   /projects/:id/canvas                  视觉工作台（项目默认页）
 *   /projects/:id/batch                   批量任务
 *   /projects/:id/assets                  素材库
 *   /projects/:id/runs                    运行记录
 *   /projects/:id/settings                项目内设置（保留侧栏）
 *   /settings                             无项目时的设置
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type RouteName =
  | 'landing'
  | 'projects'
  | 'canvas'
  | 'batch'
  | 'assets'
  | 'runs'
  | 'settings'
  | 'settings-global'
  | 'unknown';

export type ProjectSection = 'canvas' | 'batch' | 'assets' | 'runs' | 'settings';

export type Route =
  | { name: 'landing' }
  | { name: 'projects' }
  | { name: ProjectSection; projectId: string }
  | { name: 'settings-global' }
  | { name: 'unknown'; path: string };

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // 畸形 % 编码不应白屏
  }
}

function parseHash(): { path: string; route: Route } {
  let raw = '';
  try {
    raw = window.location.hash.replace(/^#/, '');
  } catch {
    raw = '';
  }
  const path = raw || '/';
  let clean = '/';
  try {
    clean = path.split('?')[0].replace(/\/+$/, '') || '/';
  } catch {
    clean = '/';
  }

  if (clean === '/' || clean === '') return { path, route: { name: 'landing' } };
  if (clean === '/projects') return { path, route: { name: 'projects' } };
  if (clean === '/settings') return { path, route: { name: 'settings-global' } };

  const project = /^\/projects\/([^/]+)(?:\/(canvas|batch|assets|runs|settings))?$/.exec(clean);
  if (project) {
    const projectId = safeDecode(project[1]);
    if (!projectId) return { path, route: { name: 'unknown', path: clean } };
    const section = (project[2] ?? 'canvas') as ProjectSection;
    return { path, route: { name: section, projectId } };
  }

  return { path, route: { name: 'unknown', path: clean } };
}

export function buildPath(
  name: RouteName,
  params?: { projectId?: string; section?: string },
): string {
  const withSection = (base: string) =>
    params?.section ? `${base}?section=${encodeURIComponent(params.section)}` : base;
  switch (name) {
    case 'landing':
      return '/';
    case 'projects':
      return '/projects';
    case 'settings':
      if (params?.projectId) {
        return withSection(`/projects/${encodeURIComponent(params.projectId)}/settings`);
      }
      return withSection('/settings');
    case 'settings-global':
      return withSection('/settings');
    case 'canvas':
    case 'batch':
    case 'assets':
    case 'runs':
      return `/projects/${encodeURIComponent(params?.projectId ?? '')}/${name}`;
    default:
      return '/projects';
  }
}

export function hashQuery(path: string): URLSearchParams {
  const query = path.split('?')[1] ?? '';
  return new URLSearchParams(query);
}

export function navigate(path: string): void {
  if (!path.startsWith('/')) path = `/${path}`;
  if (window.location.hash === `#${path}`) {
    // 同路径也要通知（极少数强制刷新场景）
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = path;
  }
}

export type RouterValue = {
  path: string;
  route: Route;
  navigate: (path: string) => void;
};

const RouterContext = createContext<RouterValue | null>(null);

export function HashRouter({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => parseHash());

  useEffect(() => {
    const onChange = () => setState(parseHash());
    window.addEventListener('hashchange', onChange);
    // 首次进入空 hash 时落到官网首页（/），由官网 CTA 进入 /projects
    if (!window.location.hash) window.location.hash = '/';
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return (
    <RouterContext.Provider value={{ ...state, navigate }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter 必须在 HashRouter 内使用');
  return ctx;
}

/** 仅触发浏览器前进/后退的便捷跳转钩子 */
export function useNavigate() {
  return navigate;
}

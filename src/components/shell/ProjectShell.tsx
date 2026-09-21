import { useState, type ReactNode } from 'react';
import { GitBranch, Layers, Images, History, Settings, Rocket } from 'lucide-react';
import { buildPath, useRouter } from '../../router/hashRouter';
import type { Project } from '../../data/projectStore';
import { ModelStatusPill } from './ModelStatusPill';
import type { ModelSettings } from '../../shared/types';
import type { CanvasChrome } from '../../pages/WorkflowEditorPage';

const NAV: Array<{ section: 'canvas' | 'batch' | 'assets' | 'runs'; label: string; icon: typeof GitBranch }> = [
  { section: 'canvas', label: '工作流', icon: GitBranch },
  { section: 'batch', label: '批量任务', icon: Layers },
  { section: 'assets', label: '素材', icon: Images },
  { section: 'runs', label: '运行记录', icon: History },
];

/**
 * 专注式项目壳（docs/12 §2）：
 * 56px 顶栏 + 56px 收窄图标导航轨；低频功能（设置）收入顶栏“更多”菜单。
 */
export function ProjectShell({
  project,
  settings,
  configured,
  saveState,
  savedAt = null,
  canvasChrome = null,
  children,
}: {
  project: Project;
  settings: ModelSettings | null;
  configured: boolean;
  saveState?: 'idle' | 'saving' | 'saved' | 'failed';
  savedAt?: number | null;
  canvasChrome?: CanvasChrome | null;
  children: ReactNode;
}) {
  const { route, navigate } = useRouter();
  const active = (route as { name?: string }).name;
  const [menuOpen, setMenuOpen] = useState(false);

  const saveText =
    saveState === 'saving'
      ? '保存中…'
      : saveState === 'saved'
        ? savedAt
          ? `已保存 ${formatClock(savedAt)}`
          : '已保存'
        : saveState === 'failed'
          ? '保存失败'
          : '';

  return (
    <div className="app-shell focus-shell" data-testid="project-shell">
      <header className="topbar focus-topbar">
        <a
          className="back-btn"
          href={`#${buildPath('projects')}`}
          onClick={(e) => {
            e.preventDefault();
            navigate(buildPath('projects'));
          }}
        >
          ← <span className="nav-text">项目</span>
        </a>
        <div className="project-name" title={project.name} data-testid="shell-project-name">
          {project.name}
        </div>
        {canvasChrome && (
          <span className="wf-version badge plain" data-testid="workflow-version">
            {canvasChrome.versionText}
          </span>
        )}
        {saveText && (
          <span className={`save-state ${saveState === 'failed' ? 'failed' : saveState === 'saving' ? 'saving' : ''}`} data-testid="save-state">
            {saveText}
          </span>
        )}
        {canvasChrome?.publishMsg && (
          <span className={`publish-msg ${canvasChrome.publishMsg.kind}`} data-testid="publish-msg">
            {canvasChrome.publishMsg.text}
          </span>
        )}
        <div className="spacer" />
        <div className="topbar-actions">
          <ModelStatusPill
            settings={settings}
            configured={configured}
            onClick={() => navigate(buildPath('settings', { projectId: project.id, section: 'model' }))}
          />
          {canvasChrome && (
            <button
              type="button"
              className="btn primary"
              disabled={canvasChrome.publishDisabled}
              title={canvasChrome.publishTitle}
              onClick={canvasChrome.onPublish}
              data-testid="publish-workflow"
            >
              <Rocket size={14} /> 发布
            </button>
          )}
          <div className="top-menu">
            <button type="button" className="btn" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}>
              更多 ▾
            </button>
            {menuOpen && (
              <>
                <div className="top-menu-scrim" onMouseDown={() => setMenuOpen(false)} />
                <div className="top-menu-pop" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate(buildPath('settings', { projectId: project.id }));
                    }}
                    data-testid="menu-settings"
                  >
                    设置
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="shell-body focus-body">
        <nav className="sidenav focus-rail" aria-label="项目导航" data-testid="sidenav">
          {NAV.map((item) => {
            const href = buildPath(item.section, { projectId: project.id });
            const Icon = item.icon;
            return (
              <a
                key={item.section}
                className={`nav-item rail-item ${active === item.section ? 'active' : ''}`}
                href={`#${href}`}
                title={item.label}
                aria-label={item.label}
                aria-current={active === item.section ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(href);
                }}
              >
                <span className="nav-ico" aria-hidden><Icon size={18} strokeWidth={1.8} /></span>
                <span className="rail-tooltip">{item.label}</span>
              </a>
            );
          })}
          <div className="rail-foot">
            <a
              className={`nav-item rail-item ${active === 'settings' ? 'active' : ''}`}
              href={`#${buildPath('settings', { projectId: project.id })}`}
              title="设置"
              aria-label="设置"
              aria-current={active === 'settings' ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(buildPath('settings', { projectId: project.id }));
              }}
            >
              <span className="nav-ico" aria-hidden><Settings size={18} strokeWidth={1.8} /></span>
              <span className="rail-tooltip">设置</span>
            </a>
          </div>
        </nav>
        <main className="shell-main">{children}</main>
      </div>
    </div>
  );
}

function formatClock(ts: number) {
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 项目首页：进入项目与继续工作的生产工作台（非营销官网）。
 * 顶部：左标题/说明，右[已连接状态][设置][新建项目]；统一 36px 控件。
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Settings2, Search } from 'lucide-react';
import {
  createProject,
  deleteProject,
  filterAndSortProjects,
  listProjects,
  PROJECT_STATUS_LABELS,
  type Project,
  type ProjectSort,
  type ProjectStatusFilter,
} from '../data/projectStore';
import { createDraftFromTemplate, persistDraft } from '../data/draftStore';
import { getAsset, latestGeneratedAsset, listAssets } from '../data/assetStore';
import { buildPath, useRouter } from '../router/hashRouter';
import type { ModelSettings as ModelSettingsType } from '../shared/types';
import { maskEndpoint } from '../shared/security';
import { NewProjectDialog } from '../components/NewProjectDialog';

export function ProjectsPage({
  settings,
  configured,
}: {
  settings: ModelSettingsType | null;
  configured: boolean;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  /** projectId → 封面 dataUri（仅收录解析成功的项目，缺失走占位） */
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ProjectStatusFilter>('all');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const { navigate } = useRouter();

  /** 解析单个项目封面：优先 coverAssetId；悬空/非生成图时回退最新一张生成图 */
  async function resolveCover(project: Project): Promise<string | undefined> {
    const direct = await getAsset(project.id, project.coverAssetId);
    if (direct?.kind === 'generated' && direct.dataUri) return direct.dataUri;
    const latest = latestGeneratedAsset(await listAssets(project.id));
    return latest?.dataUri;
  }

  const load = async () => {
    const next = await listProjects();
    setProjects(next);
    const entries = (
      await Promise.all(
        next.map(async (p): Promise<[string, string] | null> => {
          const dataUri = await resolveCover(p);
          return dataUri ? [p.id, dataUri] : null;
        }),
      )
    ).filter((entry): entry is [string, string] => entry !== null);
    setCovers(Object.fromEntries(entries));
  };
  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(
    () => filterAndSortProjects(projects, query, status, sort),
    [projects, query, status, sort],
  );

  async function handleCreate(input: { name: string; note: string; templateId: string }) {
    setBusy(true);
    try {
      const p = await createProject(input.name, input.note, input.templateId);
      // 复制模板生成独立 Draft 并立即落盘
      const draft = createDraftFromTemplate(p.id, p.name, input.templateId);
      await persistDraft(draft);
      setCreating(false);
      navigate(buildPath('canvas', { projectId: p.id }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="home projects-home">
      <div className="home-inner projects-inner">
        {/* 顶部：左标题说明，右操作区 */}
        <header className="projects-hero">
          <div className="projects-hero-text">
            <h1>视觉生产工作台</h1>
            <p className="projects-hero-sub">
              上传商品图即可生成；需要灵感时先分析参考图、编辑或优化提示词，再把同一发布工作流复用于批量商品。
            </p>
          </div>
          <div className="projects-hero-actions">
            <button
              type="button"
              className={`conn-pill ${configured ? 'is-on' : 'is-off'}`}
              onClick={() => navigate(buildPath('settings'))}
              title={configured ? '已连接，点击打开设置' : '未连接，点击配置模型'}
              data-testid="model-connection"
            >
              <span className="conn-dot" />
              {configured
                ? `已连接 · ${maskEndpoint(settings?.imageEndpoint || settings?.seedEndpoint || '')}`
                : '未连接'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => navigate(buildPath('settings'))}
              data-testid="open-settings"
            >
              <Settings2 size={15} />
              设置
            </button>
            <button type="button" className="btn primary" onClick={() => setCreating(true)} data-testid="new-project">
              <Plus size={15} />
              新建项目
            </button>
          </div>
        </header>

        {/* 工具栏 */}
        {projects.length > 0 && (
          <div className="home-toolbar projects-toolbar">
            <div className="search-box">
              <Search size={14} />
              <input
                type="text"
                placeholder="搜索项目名称或备注…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索项目"
                data-testid="project-search"
              />
            </div>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatusFilter)}
              aria-label="按状态筛选"
              data-testid="project-status-filter"
            >
              <option value="all">全部状态</option>
              {Object.entries(PROJECT_STATUS_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as ProjectSort)}
              aria-label="排序方式"
              data-testid="project-sort"
            >
              <option value="recent">最近修改</option>
              <option value="created">最近创建</option>
              <option value="name">名称</option>
            </select>
          </div>
        )}

        {projects.length === 0 ? (
          <div className="empty-state projects-empty" data-testid="first-use-empty">
            <h3>还没有项目</h3>
            <p>从“直接生成”或“参考图辅助生成”开始。无需先配置模型也可以搭建和保存工作流。</p>
            <div className="btn-row">
              <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                <Plus size={15} />
                新建项目
              </button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <h3>没有符合条件的项目</h3>
            <p>试试更换关键词或清除状态筛选。</p>
          </div>
        ) : (
          <div className="project-grid" data-testid="project-grid">
            {visible.map((p) => (
              <ProjectCard key={p.id} project={p} coverSrc={covers[p.id]} onDeleted={load} />
            ))}
          </div>
        )}
      </div>

      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={handleCreate}
        busy={busy}
      />
    </div>
  );
}

function ProjectCard({
  project,
  coverSrc,
  onDeleted,
}: {
  project: Project;
  coverSrc?: string;
  onDeleted: () => void;
}) {
  const { navigate } = useRouter();
  // dataUri 损坏时回退占位，保证任何情况下都不出现浏览器裂图图标
  const [imgError, setImgError] = useState(false);
  const showCover = !!coverSrc && !imgError;
  return (
    <button
      type="button"
      className="project-card"
      onClick={() => navigate(buildPath('canvas', { projectId: project.id }))}
      data-testid={`project-card-${project.id}`}
    >
      <div className="project-cover">
        {showCover ? (
          <img
            key={coverSrc}
            src={coverSrc}
            alt=""
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <span aria-hidden className="project-cover-placeholder">▦</span>
        )}
      </div>
      <div className="project-card-body">
        <div className="project-card-title" title={project.name}>
          {project.name}
        </div>
        {project.note && <div className="project-card-note" title={project.note}>{project.note}</div>}
        <div className="project-card-meta">
          <span className={`badge ${statusBadgeClass(project.status)}`}>{PROJECT_STATUS_LABELS[project.status]}</span>
          <span className="hint">{formatTime(project.updatedAt)}</span>
        </div>
        <div
          className="project-card-foot"
          role="button"
          tabIndex={0}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <span className="hint">
            生成 {project.generatedCount} · 待确认 {project.awaitingReviewCount}
          </span>
          <span
            className="project-delete"
            role="button"
            tabIndex={0}
            title="删除项目"
            onClick={async (e) => {
              e.stopPropagation();
              if (window.confirm(`删除项目「${project.name}」及其工作流与记录？`)) {
                await deleteProject(project.id);
                onDeleted();
              }
            }}
          >
            删除
          </span>
        </div>
      </div>
    </button>
  );
}

function statusBadgeClass(s: Project['status']): string {
  switch (s) {
    case 'completed':
      return 'passed';
    case 'running':
      return 'running';
    case 'recipe-ready':
      return 'needs-review';
    default:
      return 'rejected';
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

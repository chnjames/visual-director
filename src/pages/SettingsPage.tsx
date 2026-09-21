import { useEffect, useState } from 'react';
import { ModelSettingsModal } from '../components/ModelSettingsModal';
import {
  deleteProject,
  updateProject,
  type Project,
} from '../data/projectStore';
import { buildPath, hashQuery, useRouter } from '../router/hashRouter';
import type { ModelSettings } from '../shared/types';
import {
  ASPECT_RATIO_OPTIONS,
  DEFAULT_GENERATION_DEFAULTS,
  normalizeGenerationDefaults,
  RESOLUTION_OPTIONS,
  TARGET_USE_OPTIONS,
  type GenerationDefaults,
} from '../workflow/generationOptions';

/**
 * 设置：项目内三组（项目 / 模型连接 / 生成默认值）；无项目时只有模型连接。
 * 密钥是当前标签页会话、对所有项目共用，不是按项目分开的。
 */
export function SettingsPage({
  settings,
  onSave,
  onClear,
  project = null,
  onProjectChange,
}: {
  settings: ModelSettings | null;
  onSave: (s: ModelSettings) => void;
  onClear: () => void;
  project?: Project | null;
  onProjectChange?: (project: Project) => void;
}) {
  const { path, navigate } = useRouter();

  useEffect(() => {
    if (hashQuery(path).get('section') !== 'model') return;
    document.getElementById('settings-model')?.scrollIntoView?.({ block: 'start' });
  }, [path]);

  return (
    <div className="page-scroll" data-testid="settings-page">
      <div className="page-container">
        {!project && (
          <a
            className="back-btn settings-back"
            href={`#${buildPath('projects')}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(buildPath('projects'));
            }}
          >
            ← 项目
          </a>
        )}
        <h1 className="page-title">设置</h1>
        <p className="page-sub">
          {project
            ? '项目信息、模型连接和新建生成节点的默认参数。密钥只保存在本标签页会话中。'
            : '图片生成和文本分析分开配置。密钥只保存在本标签页会话中，对所有项目共用。'}
        </p>

        {project && <ProjectSection project={project} onProjectChange={onProjectChange} />}

        <section className="section-card" id="settings-model" data-testid="settings-model">
          <h2>模型连接</h2>
          <p className="hint settings-section-hint">
            密钥保存在当前浏览器标签页的会话里，关闭标签页即清除；对所有项目共用，不是按项目分开的。
          </p>
          <ModelSettingsModal
            embedded
            open
            initial={settings}
            onSave={onSave}
            onClear={onClear}
            onClose={() => {}}
          />
        </section>

        {project && <GenerationDefaultsSection project={project} onProjectChange={onProjectChange} />}
      </div>
    </div>
  );
}

function ProjectSection({
  project,
  onProjectChange,
}: {
  project: Project;
  onProjectChange?: (project: Project) => void;
}) {
  const { navigate } = useRouter();
  const [name, setName] = useState(project.name);
  const [note, setNote] = useState(project.note ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const readonly = project.readonlySample === true;

  useEffect(() => {
    setName(project.name);
    setNote(project.note ?? '');
  }, [project.id, project.name, project.note]);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setMsg('请填写项目名称');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const next = await updateProject(project.id, { name: trimmed, note });
      if (!next) {
        setMsg('项目不存在或已删除');
        return;
      }
      onProjectChange?.(next);
      setMsg('项目信息已保存');
    } catch (e) {
      setMsg((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (readonly) return;
    const ok = window.confirm(
      `删除项目「${project.name}」？\n\n将同时删除工作流草稿、已发布版本、运行记录、素材和批量任务，且无法恢复。`,
    );
    if (!ok) return;
    await deleteProject(project.id);
    navigate(buildPath('projects'));
  }

  return (
    <section className="section-card" id="settings-project" data-testid="settings-project">
      <h2>项目</h2>
      <p className="hint settings-section-hint">修改名称和备注；删除会级联清掉本项目的全部本地数据。</p>
      <label className="field">
        <span>项目名称</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={readonly}
          data-testid="project-name-input"
        />
      </label>
      <label className="field">
        <span>备注</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          disabled={readonly}
          placeholder="这批图用于哪个渠道、想要什么风格…"
          data-testid="project-note-input"
        />
      </label>
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          disabled={readonly || saving}
          onClick={() => void handleSave()}
          data-testid="save-project-info"
        >
          {saving ? '保存中…' : '保存项目信息'}
        </button>
        {msg && <span className="hint">{msg}</span>}
      </div>

      <div className="settings-danger">
        <h3>删除项目</h3>
        <p className="hint">
          删除后不可恢复。将同时删除本项目的工作流草稿、已发布版本、运行记录、素材和批量任务。
        </p>
        <button
          type="button"
          className="btn danger"
          disabled={readonly}
          onClick={() => void handleDelete()}
          data-testid="delete-project"
        >
          删除此项目
        </button>
      </div>
    </section>
  );
}

function GenerationDefaultsSection({
  project,
  onProjectChange,
}: {
  project: Project;
  onProjectChange?: (project: Project) => void;
}) {
  const [defaults, setDefaults] = useState<GenerationDefaults>(
    normalizeGenerationDefaults(project.generationDefaults ?? DEFAULT_GENERATION_DEFAULTS),
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const readonly = project.readonlySample === true;

  useEffect(() => {
    setDefaults(normalizeGenerationDefaults(project.generationDefaults ?? DEFAULT_GENERATION_DEFAULTS));
  }, [project.id, project.generationDefaults]);

  function patch(partial: Partial<GenerationDefaults>) {
    setDefaults((prev) => normalizeGenerationDefaults({ ...prev, ...partial }));
    setMsg(null);
  }

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      const next = await updateProject(project.id, { generationDefaults: defaults });
      if (!next) {
        setMsg('项目不存在或已删除');
        return;
      }
      onProjectChange?.(next);
      setMsg('生成默认值已保存');
    } catch (e) {
      setMsg((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="section-card" id="settings-generation" data-testid="settings-generation">
      <h2>生成默认值</h2>
      <p className="hint settings-section-hint">
        只影响之后新加入的「商品场景生成」节点，不会改画布上已有节点。
      </p>
      <div className="settings-grid">
        <label className="field">
          <span>输出用途</span>
          <select
            value={defaults.targetUse}
            disabled={readonly}
            onChange={(e) => patch({ targetUse: e.target.value })}
            data-testid="gen-target-use"
          >
            {TARGET_USE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>比例</span>
          <select
            value={defaults.aspectRatio}
            disabled={readonly}
            onChange={(e) => patch({ aspectRatio: e.target.value })}
            data-testid="gen-aspect"
          >
            {ASPECT_RATIO_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>分辨率</span>
          <select
            value={defaults.resolution}
            disabled={readonly}
            onChange={(e) => patch({ resolution: e.target.value as GenerationDefaults['resolution'] })}
            data-testid="gen-resolution"
          >
            {RESOLUTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>数量</span>
          <input
            type="number"
            min={1}
            max={4}
            value={defaults.count}
            disabled={readonly}
            onChange={(e) => patch({ count: Number(e.target.value) })}
            data-testid="gen-count"
          />
        </label>
      </div>
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          disabled={readonly || saving}
          onClick={() => void handleSave()}
          data-testid="save-generation-defaults"
        >
          {saving ? '保存中…' : '保存生成默认值'}
        </button>
        {msg && <span className="hint">{msg}</span>}
      </div>
    </section>
  );
}

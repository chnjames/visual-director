/**
 * 新建项目对话框（docs/11 §三）。
 * 必填名称、可选备注、必须主动选择模板后才创建（不再默认塞入完整流程）。
 * 模板由 WORKFLOW_TEMPLATES 数据驱动，页面不硬编码工作流 JSX。
 */
import { useMemo, useState } from 'react';
import { WORKFLOW_TEMPLATES } from '../workflow/graph/templates';
import { getNodeDefinition } from '../workflow/graph/registry';
import { X } from 'lucide-react';

export function NewProjectDialog({
  open,
  onClose,
  onCreate,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; note: string; templateId: string }) => void;
  busy?: boolean;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [templateId, setTemplateId] = useState<string>('standard-still-life');
  const [touched, setTouched] = useState(false);

  const selected = useMemo(
    () => WORKFLOW_TEMPLATES.find((t) => t.id === templateId) ?? WORKFLOW_TEMPLATES[1],
    [templateId],
  );

  if (!open) return null;
  const nameValid = name.trim().length > 0;
  const canCreate = nameValid && !!templateId && !busy;

  return (
    <div className="modal-backdrop npr-backdrop" onMouseDown={onClose}>
      <div
        className="modal npr-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新建项目"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="npr-head">
          <h2>新建项目</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="npr-body">
          <label className="field">
            <span>项目名称 *</span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：陶瓷花瓶秋季场景图"
              data-testid="new-project-name"
            />
            {touched && !nameValid && <span className="field-error">请填写项目名称</span>}
          </label>

          <label className="field">
            <span>项目用途 / 备注（可选）</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="这批图用于哪个渠道、想要什么风格…"
              rows={2}
              data-testid="new-project-note"
            />
          </label>

          <div className="npr-templates-label">选择工作流模板 *</div>
          <div className="npr-templates" role="radiogroup" aria-label="工作流模板">
            {WORKFLOW_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={templateId === t.id}
                className={`npr-template ${templateId === t.id ? 'selected' : ''}`}
                onClick={() => setTemplateId(t.id)}
                data-testid={`template-${t.id}`}
              >
                <div className="npr-template-top">
                  <strong>{t.name}</strong>
                  {t.blank && <span className="badge plain rejected">空白</span>}
                </div>
                <p className="npr-template-tag">{t.tagline}</p>
                <div className="npr-template-kinds">
                  {t.nodeKinds.slice(0, 8).map((k) => (
                    <span key={k} className="kind-chip" title={k}>
                      {nodeShortLabel(k)}
                    </span>
                  ))}
                  {t.nodeKinds.length > 8 && <span className="kind-chip">+{t.nodeKinds.length - 8}</span>}
                </div>
                <div className="npr-template-fit">适合：{t.fitFor}</div>
              </button>
            ))}
          </div>
          <p className="hint">创建后会复制该模板生成独立草稿，之后的编辑不会影响模板本身。</p>
        </div>

        <div className="npr-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!canCreate}
            onClick={() => {
              setTouched(true);
              if (!canCreate) return;
              onCreate({ name: name.trim(), note: note.trim(), templateId: selected.id });
            }}
            data-testid="new-project-create"
          >
            使用此模板创建
          </button>
        </div>
      </div>
    </div>
  );
}

function nodeShortLabel(type: string): string {
  return getNodeDefinition(type)?.title ?? type;
}

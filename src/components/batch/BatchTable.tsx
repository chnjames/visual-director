import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useBatchJob } from '../../hooks/useBatchJob';
import type { ModelSettings } from '../../shared/types';
import { isImageConfigured } from '../../shared/security';
import { buildPath } from '../../router/hashRouter';
import { ImageListControl } from '../flow/ImageListControl';
import {
  ASPECT_RATIO_OPTIONS,
  normalizeGenerationResolution,
  RESOLUTION_OPTIONS,
  TARGET_USE_OPTIONS,
} from '../../workflow/generationOptions';

const STATUS_LABEL: Record<string, string> = {
  pending: '待运行',
  running: '运行中',
  'waiting-user': '待人工处理',
  done: '完成',
  failed: '失败',
  skipped: '已跳过',
};

export function BatchTable({
  projectId,
  settings,
  onOpenSettings,
}: {
  projectId: string;
  settings: ModelSettings | null;
  configured: boolean;
  onOpenSettings: () => void;
}) {
  const batch = useBatchJob(projectId);
  const { job, contract, budget } = batch;
  const locked = job.status === 'running';
  const imageConfigured = isImageConfigured(settings);
  const hasPendingRows = job.rows.some((row) => row.status === 'pending');
  const counts = {
    pending: job.rows.filter((row) => row.status === 'pending').length,
    running: job.rows.filter((row) => row.status === 'running').length,
    done: job.rows.filter((row) => row.status === 'done').length,
    failed: job.rows.filter((row) => row.status === 'failed').length,
  };

  if (!batch.loaded) return <p className="hint">正在加载批量任务…</p>;

  const showShared =
    !!contract &&
    (contract.shared.referenceImages ||
      contract.shared.purpose ||
      contract.shared.positivePrompt);
  const showRowPrompt = !!contract?.perRow.promptOverride;
  const showOverrides = !!contract?.perRow.generationOverrides;

  return (
    <div className="batch-table-workspace" data-testid="batch-table">
      <section className="section-card">
        <div className="batch-toolbar">
          <div className="field" style={{ minWidth: 280, margin: 0 }}>
            <label>已发布工作流</label>
            {batch.versions.length ? (
              <select
                className="textinput"
                value={job.workflowVersionId ?? ''}
                disabled={locked}
                onChange={(event) => batch.selectVersion(event.target.value)}
                data-testid="batch-version"
              >
                {batch.versions.map((version) => (
                  <option value={version.id} key={version.id}>
                    v{version.versionNo} · {version.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="hint err">
                还没有可批量运行的版本。请先在画布发布「直接生成」或「参考图辅助生成」工作流。
              </p>
            )}
          </div>
          <div className="spacer" />
          <span className="badge plain" data-testid="batch-status">
            {job.status === 'running'
              ? '运行中'
              : job.status === 'paused'
                ? '已暂停'
                : job.status === 'completed'
                  ? '已完成'
                  : '编辑中'}
          </span>
          {job.status === 'running' ? (
            <button type="button" className="btn" onClick={batch.pause}>
              完成本行后暂停
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={!batch.versions.length || !hasPendingRows || !contract?.runnable}
              onClick={() => {
                if (!imageConfigured) {
                  onOpenSettings();
                  return;
                }
                void batch.start(settings);
              }}
              data-testid="batch-start"
            >
              {job.status === 'paused' ? '继续批量' : '开始批量'}
            </button>
          )}
          <button type="button" className="btn" onClick={() => void batch.reset()}>
            <RotateCcw size={14} /> 新建批次
          </button>
        </div>

        {contract && (
          <p className="hint" style={{ marginTop: 12 }} data-testid="batch-contract-summary">
            本版本需要：{contract.summary}
            {budget && job.rows.length > 0
              ? ` · 预计约 ${budget.expected} 次模型调用（${budget.rowCount} 行 × ${budget.perRow}）`
              : ''}
          </p>
        )}
        {contract && !contract.runnable && (
          <p className="hint err">{contract.reason}</p>
        )}
        {job.rows.length > 0 && (
          <div className="batch-progress-strip" data-testid="batch-progress">
            <span>待跑 {counts.pending}</span>
            <span>进行中 {counts.running}</span>
            <span>完成 {counts.done}</span>
            <span>失败 {counts.failed}</span>
          </div>
        )}
        {batch.actionError && <p className="hint err">{batch.actionError}</p>}
      </section>

      {showShared && (
        <section className="section-card batch-shared-card" data-testid="batch-shared-inputs">
          <h2 className="batch-shared-title">整批共用</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            这些输入对所有商品相同：参考图决定画面风格，提示词决定怎么写；下面表格只换商品图。
          </p>
          <div className="batch-shared-grid">
            {contract?.shared.referenceImages && (
              <div className="generation-config-section">
                <div className="generation-config-title">
                  <strong>参考图</strong>
                  <span>1–5 张，只用于分析，不会代替商品图</span>
                </div>
                <ImageListControl
                  value={job.shared.referenceImages}
                  max={5}
                  addLabel="上传参考图"
                  disabled={locked}
                  onChange={batch.setSharedReferenceImages}
                />
              </div>
            )}
            {contract?.shared.purpose && (
              <label className="field">
                <span>用途</span>
                <select
                  className="textinput"
                  value={job.shared.purpose || 'main-scene'}
                  disabled={locked}
                  onChange={(event) => batch.patchShared({ purpose: event.target.value })}
                  data-testid="batch-shared-purpose"
                >
                  {TARGET_USE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {contract?.shared.positivePrompt && (
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span>提示词</span>
                <textarea
                  rows={4}
                  className="textinput"
                  value={job.shared.positivePrompt}
                  disabled={locked}
                  placeholder="描述希望生成的画面；可从画布「提示词编辑」复制，或直接填写"
                  onChange={(event) => batch.patchShared({ positivePrompt: event.target.value })}
                  data-testid="batch-shared-prompt"
                />
              </label>
            )}
          </div>
        </section>
      )}

      <div className="section-card" style={{ overflowX: 'auto' }}>
        <div className="batch-rows-head">
          <h2 className="batch-shared-title" style={{ margin: 0 }}>
            商品行
          </h2>
          <button
            type="button"
            className="btn"
            disabled={locked}
            onClick={batch.addRow}
            data-testid="batch-add-row"
          >
            <Plus size={14} /> 添加商品
          </button>
        </div>
        <table className="batch-table">
          <thead>
            <tr>
              <th>商品</th>
              <th style={{ minWidth: 220 }}>商品图片</th>
              {showRowPrompt && <th style={{ minWidth: 180 }}>提示词覆盖</th>}
              {showOverrides && (
                <>
                  <th>输出用途</th>
                  <th>比例</th>
                  <th>分辨率</th>
                  <th>数量</th>
                </>
              )}
              <th>状态</th>
              <th>结果</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {job.rows.map((row) => (
              <tr key={row.id} data-testid={`batch-row-${row.id}`}>
                <td>
                  <input
                    className="textinput"
                    value={row.name}
                    disabled={locked}
                    onChange={(event) =>
                      batch.patchRow(row.id, { name: event.target.value })
                    }
                  />
                </td>
                <td>
                  <ImageListControl
                    value={row.productImages}
                    max={10}
                    addLabel="上传商品图"
                    disabled={locked}
                    onChange={(images) => batch.setRowImages(row.id, images)}
                  />
                </td>
                {showRowPrompt && (
                  <td>
                    <textarea
                      rows={3}
                      className="textinput"
                      value={row.overrides.positivePrompt ?? ''}
                      disabled={locked}
                      placeholder={
                        job.shared.positivePrompt || contract?.defaultPositivePrompt
                          ? '留空则用上方/版本提示词'
                          : '可选：覆盖本行提示词'
                      }
                      onChange={(event) =>
                        batch.patchRow(row.id, {
                          overrides: {
                            ...row.overrides,
                            positivePrompt: event.target.value,
                          },
                        })
                      }
                    />
                  </td>
                )}
                {showOverrides && (
                  <>
                    <td>
                      <select
                        value={row.overrides.targetUse ?? 'main-scene'}
                        disabled={locked}
                        onChange={(event) =>
                          batch.patchRow(row.id, {
                            overrides: {
                              ...row.overrides,
                              targetUse: event.target.value,
                            },
                          })
                        }
                      >
                        {TARGET_USE_OPTIONS.map((option) => (
                          <option value={option.value} key={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={row.overrides.aspectRatio ?? '1:1'}
                        disabled={locked}
                        onChange={(event) =>
                          batch.patchRow(row.id, {
                            overrides: {
                              ...row.overrides,
                              aspectRatio: event.target.value,
                            },
                          })
                        }
                      >
                        {ASPECT_RATIO_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={normalizeGenerationResolution(row.overrides.resolution)}
                        disabled={locked}
                        onChange={(event) =>
                          batch.patchRow(row.id, {
                            overrides: {
                              ...row.overrides,
                              resolution: event.target.value,
                            },
                          })
                        }
                      >
                        {RESOLUTION_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        max={4}
                        value={row.overrides.count ?? 1}
                        disabled={locked}
                        onChange={(event) =>
                          batch.patchRow(row.id, {
                            overrides: {
                              ...row.overrides,
                              count: Number(event.target.value),
                            },
                          })
                        }
                        style={{ width: 62 }}
                      />
                    </td>
                  </>
                )}
                <td>
                  <span className={`badge plain ${row.status}`}>
                    {STATUS_LABEL[row.status]}
                  </span>
                  {row.currentStep && <div className="hint">{row.currentStep}</div>}
                  {row.error && <div className="hint err">{row.error}</div>}
                </td>
                <td>{row.resultCount ? `${row.resultCount} 张` : '—'}</td>
                <td>
                  <div className="btn-row">
                    {row.runId && (
                      <a
                        className="btn"
                        href={buildPath('runs', { projectId })}
                        title={`运行记录 ${row.runId}`}
                      >
                        查看详情
                      </a>
                    )}
                    {row.status === 'failed' && (
                      <button type="button" className="btn" onClick={() => batch.retry(row.id)}>
                        重试
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={locked}
                      aria-label={`删除 ${row.name}`}
                      onClick={() => batch.removeRow(row.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!job.rows.length && (
          <div className="empty-state">
            <h3>还没有商品</h3>
            <p>先选好版本、填好上方共用输入，再为每个 SKU 加一行商品图。</p>
          </div>
        )}
      </div>
    </div>
  );
}

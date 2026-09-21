import { useEffect, useState } from 'react';
import { useSingleItemWorkflow } from '../hooks/useSingleItemWorkflow';
import { listRuns, type CanvasRun } from '../data/runStore';
import { BATCH_STATE_LABELS } from '../workflow/workflowConstants';

const AUDIT_LABEL: Record<string, string> = {
  passed: '通过',
  failed: '失败',
  pending: '待确认',
  'needs-review': '待确认',
  warning: '警告',
};

const RUN_STATUS: Record<CanvasRun['status'], string> = {
  done: '完成',
  failed: '失败',
  partial: '部分完成',
};

/**
 * 运行记录：统一展示画布与批量运行；旧单件流程作为历史保留。
 */
export function RunsPage({ projectId }: { projectId: string }) {
  const { wf, loaded } = useSingleItemWorkflow(projectId);
  const [canvasRuns, setCanvasRuns] = useState<CanvasRun[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listRuns(projectId).then((rows) => {
        if (!cancelled) setCanvasRuns(rows);
      });
    };
    load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [projectId]);

  return (
    <div className="page-scroll">
      <div className="page-container">
        <h1 className="page-title">运行记录</h1>
        <p className="page-sub">
          画布试运行与批量商品结果会写入本机 IndexedDB；下方保留旧的单件流程历史。
        </p>

        {canvasRuns === null ? (
          <p className="hint">正在加载运行记录…</p>
        ) : canvasRuns.length === 0 ? (
          <div className="empty-state" data-testid="canvas-runs-empty">
            <h3>还没有运行记录</h3>
            <p>完成画布试运行或批量商品任务后，记录会出现在这里。</p>
          </div>
        ) : (
          <div className="run-list" data-testid="canvas-runs-list">
            {canvasRuns.map((run) => (
              <article className="section-card" key={run.id}>
                <div className="run-card-head">
                  <h2>
                    {run.kind === 'chain'
                      ? '按连线运行'
                      : run.kind === 'batch-item'
                        ? `批量商品 · ${run.nodeTitle || '未命名'}`
                        : run.nodeTitle || '单节点运行'}
                    <span className="hint" style={{ marginLeft: 8, fontWeight: 400 }}>
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </h2>
                  <span
                    className={`badge plain ${
                      run.status === 'done' ? 'confirmed' : run.status === 'failed' ? 'failed' : 'pending'
                    }`}
                  >
                    {RUN_STATUS[run.status]}
                  </span>
                </div>
                {run.message && <p className="hint">{run.message}</p>}
                {(run.images?.length
                  ? run.images
                  : run.imageDataUri && run.mediaType
                    ? [{ dataUri: run.imageDataUri, mediaType: run.mediaType }]
                    : []
                ).map((image, index) => (
                  <img
                    className="genimg run-shot"
                    src={image.dataUri}
                    alt={`运行生成图 ${index + 1}`}
                    key={`${run.id}-image-${index}`}
                  />
                ))}
                {run.audit && (
                  <div className="kv-list">
                    <span className="k">综合分</span>
                    <span>{run.audit.compositeScore}</span>
                    <span className="k">身份 / 配方</span>
                    <span>
                      {run.audit.identityScore} / {run.audit.recipeScore}
                    </span>
                    <span className="k">任务 / 技术</span>
                    <span>
                      {run.audit.taskScore} / {run.audit.technicalScore}
                    </span>
                    <span className="k">结论</span>
                    <span>{AUDIT_LABEL[run.audit.status] ?? run.audit.status}</span>
                  </div>
                )}
                {run.steps.length > 0 && (
                  <details className="tech-details">
                    <summary>执行步骤（{run.steps.length}）</summary>
                    <ol>
                      {run.steps.map((s, i) => (
                        <li key={`${s.nodeId}-${i}`}>
                          {s.title} · {s.status}
                          {s.message ? ` · ${s.message}` : ''}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                <p className="hint">
                  模型调用 {run.callsUsed} 次{run.recipeBound ? ' · 已绑定确认配方' : ''}
                  {run.workflowVersionNo ? ` · 工作流 v${run.workflowVersionNo}` : ''}
                </p>
              </article>
            ))}
          </div>
        )}

        <h2 className="page-title" style={{ fontSize: 18, marginTop: 36 }}>
          历史 · 旧单件流程
        </h2>
        {!loaded ? (
          <p className="hint">正在加载…</p>
        ) : !wf ? (
          <div className="empty-state">
            <h3>无历史单件流程</h3>
            <p>迁移前的单件运行会显示在这里。</p>
          </div>
        ) : (
          <>
            <p className="hint">
              工作流 {wf.id} · 当前状态：{BATCH_STATE_LABELS[wf.state]} · 模型调用 {wf.callsUsed} 次
            </p>
            {wf.attempts.length === 0 ? (
              <div className="empty-state">
                <h3>尚未生成任何版本</h3>
                <p>流程已建立，但还没有一次完成的生成。</p>
              </div>
            ) : (
              <div className="run-list">
                {wf.attempts.map((attempt, idx) => {
                  const status = attempt.audit?.status ?? attempt.status;
                  const badge =
                    attempt.audit?.status === 'passed'
                      ? 'confirmed'
                      : attempt.audit?.status === 'failed'
                        ? 'failed'
                        : attempt.audit
                          ? 'pending'
                          : 'rejected';
                  return (
                    <article className="section-card" key={attempt.id}>
                      <div className="run-card-head">
                        <h2>
                          第 {idx + 1} 次 · V{attempt.version}
                        </h2>
                        <span className={`badge plain ${badge}`}>{AUDIT_LABEL[status] ?? status}</span>
                      </div>
                      {attempt.image && (
                        <img className="genimg run-shot" src={attempt.image.dataUri} alt={`V${attempt.version}`} />
                      )}
                      {attempt.audit && (
                        <div className="kv-list">
                          <span className="k">综合分</span>
                          <span>{attempt.audit.compositeScore}</span>
                          <span className="k">身份 / 配方</span>
                          <span>
                            {attempt.audit.identityScore} / {attempt.audit.recipeScore}
                          </span>
                          <span className="k">任务 / 技术</span>
                          <span>
                            {attempt.audit.taskScore} / {attempt.audit.technicalScore}
                          </span>
                          <span className="k">问题数</span>
                          <span>{attempt.audit.issues.length}</span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

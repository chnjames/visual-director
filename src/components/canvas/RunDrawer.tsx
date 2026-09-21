import type { SingleItemWorkflow } from '../../workflow/workflowTypes';
import { WORKFLOW_NODE_LABELS, estimateCallBudget, type WorkflowNodeId } from '../../workflow/workflowConstants';
import type { WorkflowApi } from '../../hooks/useCanvasWorkflow';

const TIMELINE: Array<{ id: WorkflowNodeId; test: (wf: SingleItemWorkflow | null) => 'done' | 'active' | 'review' | 'failed' | 'todo' }> = [
  {
    id: 'referenceInput',
    test: (wf) => (wf && wf.referenceImages.length > 0 ? 'done' : 'todo'),
  },
  {
    id: 'productInput',
    test: (wf) => (wf && wf.productImages.length >= 2 ? 'done' : 'todo'),
  },
  {
    id: 'recipeExtractor',
    test: (wf) => {
      if (!wf?.recipe) return wf?.state === 'analyzing' ? 'active' : 'todo';
      return wf.recipeConfirmed ? 'done' : 'review';
    },
  },
  {
    id: 'identityLock',
    test: (wf) => {
      if (!wf?.recipeConfirmed) return 'todo';
      if (!wf.identityConfirmed) return wf.identityFeatures.length > 0 ? 'review' : wf.state === 'analyzing' ? 'active' : 'todo';
      return 'done';
    },
  },
  {
    id: 'sceneGenerator',
    test: (wf) => {
      if (wf?.state === 'generating') return 'active';
      const last = wf?.attempts[wf.attempts.length - 1];
      return last?.image ? 'done' : 'todo';
    },
  },
  {
    id: 'resultAuditor',
    test: (wf) => {
      if (wf?.state === 'auditing') return 'active';
      const a = wf?.attempts[wf.attempts.length - 1]?.audit;
      if (!a) return 'todo';
      if (a.status === 'passed') return 'done';
      if (a.status === 'failed') return 'failed';
      return 'review';
    },
  },
  {
    id: 'targetedRepair',
    test: (wf) => {
      if (wf?.state === 'repairing') return 'active';
      if (wf?.repairUsed) return 'done';
      const a = wf?.attempts[wf.attempts.length - 1]?.audit;
      return a?.status === 'failed' ? 'review' : 'todo';
    },
  },
];

/**
 * 底部运行抽屉（docs/12 §9）：折叠态一行；展开后显示节点时间线、
 * 调用预算与版本记录。暂停/终止与真实模型调用只在已配置时可用。
 */
export function RunDrawer({
  wf,
  configured,
  api,
  onSelectNode,
  expanded,
  onExpandedChange,
}: {
  wf: SingleItemWorkflow | null;
  configured: boolean;
  api: WorkflowApi;
  onSelectNode: (id: WorkflowNodeId) => void;
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
}) {
  const setExpanded = onExpandedChange;
  const budget = estimateCallBudget();
  const last = wf?.attempts[wf.attempts.length - 1];
  const interrupted = wf?.state === 'interrupted';

  const currentLabel = interrupted
    ? '流程已中断（刷新或异常）：不会自动续跑，请回到草稿或新建'
    : wf
      ? WORKFLOW_NODE_LABELS[(wf.currentNodeId ?? currentNode(wf)) as WorkflowNodeId] ?? '—'
      : '尚未开始';

  return (
    <section className={`run-drawer ${expanded ? 'expanded' : ''}`} data-testid="run-drawer" aria-label="运行抽屉">
      <div className="run-drawer-head" onClick={() => setExpanded(!expanded)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') setExpanded(!expanded); }}>
        <strong style={{ fontSize: 13 }}>{expanded ? '▾' : '▸'} 运行</strong>
        <span className="hint">{currentLabel}</span>
        <span className="hint">调用 {wf?.callsUsed ?? 0} / 预计 {budget.expected}（最坏 {budget.worst}）</span>
        <span style={{ flex: 1 }} />
        {wf && !configured && <span className="hint">未配置模型：仅展示，不能运行</span>}
        {wf && (
          <button
            type="button"
            className="btn sm danger"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm('清空当前项目的单件工作流草稿？')) void api.reset();
            }}
          >
            终止并清空
          </button>
        )}
      </div>

      {expanded && (
        <div className="run-drawer-body" onClick={(e) => e.stopPropagation()}>
          <div>
            <div className="hint" style={{ marginBottom: 6 }}>节点时间线</div>
            <div className="run-timeline">
              {TIMELINE.map((t) => {
                const state = t.test(wf);
                return (
                  <div
                    key={t.id}
                    className={`tl-item ${state === 'done' ? 'done' : state === 'review' ? 'review' : state === 'failed' ? 'failed' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onSelectNode(t.id)}
                  >
                    <span className="tl-dot" />
                    <span>{WORKFLOW_NODE_LABELS[t.id]}</span>
                    <span className="hint">
                      {state === 'done' ? '已完成' : state === 'active' ? '进行中' : state === 'review' ? '待确认' : state === 'failed' ? '失败' : '未开始'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 6 }}>调用预算</div>
            <div className="kv-list">
              <span className="k">预计</span><span>{budget.expected} 次（配方/身份/生成/验收各 1）</span>
              <span className="k">最坏</span><span>{budget.worst} 次（追加修复 1 + 重生 1 + 重验 1）</span>
              <span className="k">已用</span><span data-testid="drawer-calls-used">{wf?.callsUsed ?? 0} 次</span>
            </div>
            <ul className="hint" style={{ paddingLeft: 16, marginTop: 8 }}>
              {budget.detail.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 6 }}>版本记录</div>
            {(!wf || wf.attempts.length === 0) && <div className="hint">尚无生成版本。</div>}
            {wf?.attempts.map((a) => (
              <div key={a.id} className="card" style={{ marginBottom: 8 }}>
                <div className="result-head">
                  <strong style={{ fontSize: 12.5 }}>V{a.version}</strong>
                  <span className={`badge plain ${a.audit ? (a.audit.status === 'passed' ? 'confirmed' : a.audit.status === 'failed' ? 'failed' : 'pending') : 'rejected'}`}>
                    {a.audit ? a.audit.status : a.status}
                  </span>
                </div>
                {a.image && <img className="genimg" src={a.image.dataUri} alt={`V${a.version}`} style={{ maxHeight: 120 }} />}
                {a.audit && <span className="hint">综合 {a.audit.compositeScore} · 问题 {a.audit.issues.length}</span>}
                {a.repair && <span className="hint">修复方案{ a.repair.confirmedAt ? '已确认' : '待确认'}</span>}
              </div>
            ))}
            {last?.audit && (last.audit.status === 'warning' || last.audit.status === 'needs-review') && (
              <button type="button" className="btn sm" onClick={() => api.acceptWarning()}>人工接受为通过</button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function currentNode(wf: SingleItemWorkflow): WorkflowNodeId | string {
  if (wf.state === 'analyzing') return wf.identityFeatures.length > 0 ? 'identityLock' : 'recipeExtractor';
  if (wf.state === 'generating') return 'sceneGenerator';
  if (wf.state === 'auditing') return 'resultAuditor';
  if (wf.state === 'repairing') return 'targetedRepair';
  return wf.state;
}

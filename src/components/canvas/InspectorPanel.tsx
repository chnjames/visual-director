import { useMemo } from 'react';
import type { WorkflowNodeId } from '../../workflow/workflowConstants';
import { WORKFLOW_NODE_LABELS } from '../../workflow/workflowConstants';
import type { SingleItemWorkflow } from '../../workflow/workflowTypes';
import type { ModelSettings } from '../../shared/types';
import { ImageUploader } from '../ImageUploader';
import { EvidenceView } from '../EvidenceView';
import { RECIPE_FIELD_LABELS, IDENTITY_CATEGORY_LABELS, LIMITS } from '../../shared/constants';
import { hardConstraints } from '../../shared/schema';
import { compilePrompt } from '../../workflow/promptCompiler';
import { estimateCallBudget } from '../../workflow/workflowConstants';
import type { WorkflowApi } from '../../hooks/useCanvasWorkflow';

const AUDIT_DIMENSION_LABELS: Record<string, string> = {
  identity: '商品身份',
  recipe: '视觉配方',
  task: '场景任务',
  technical: '技术质量',
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function InspectorHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="inspector-head">
      <h2>{title}</h2>
      <div className="hint" style={{ marginTop: 4 }}>{subtitle}</div>
    </div>
  );
}

function RunDisabledNote({ configured }: { configured: boolean }) {
  if (configured) return null;
  return (
    <div className="readonly-note" data-testid="inspector-nokey">
      尚未配置模型：可上传素材、浏览完整工作流结构，但真实运行被禁用。点击顶栏“配置模型”后即可运行。
    </div>
  );
}

/**
 * 右侧节点检查器（docs/12 §7）。
 * 所有写操作经 WorkflowApi 进入状态机/编排器，检查器本身不持有业务事实；
 * 视觉配方、商品身份、结果验收从旧版平级 Tab 迁入对应节点。
 */
export function InspectorPanel({
  nodeId,
  wf,
  configured,
  api,
  settings,
  onOpenSettings,
}: {
  nodeId: WorkflowNodeId | null;
  wf: SingleItemWorkflow | null;
  configured: boolean;
  api: WorkflowApi;
  settings: ModelSettings | null;
  onOpenSettings: () => void;
}) {
  if (!nodeId) {
    return (
      <aside className="inspector" data-testid="inspector">
        <InspectorHeader title="节点检查器" subtitle="选择画布上的节点以查看配置、证据与操作" />
        <div className="inspector-empty">
          固定主干包含 7 个节点。<br />
          首版连接关系只读，不能自由连线或新增节点。
        </div>
      </aside>
    );
  }

  const title = WORKFLOW_NODE_LABELS[nodeId];

  return (
    <aside className="inspector" data-testid="inspector">
      <InspectorHeader title={title} subtitle={subtitleFor(nodeId)} />
      <div className="inspector-body">
        {nodeId === 'referenceInput' && (
          <ReferenceInputs wf={wf} api={api} configured={configured} />
        )}
        {nodeId === 'productInput' && (
          <ProductInputs wf={wf} api={api} configured={configured} />
        )}
        {nodeId === 'recipeExtractor' && (
          <RecipeInspector wf={wf} api={api} configured={configured} />
        )}
        {nodeId === 'identityLock' && (
          <IdentityInspector wf={wf} api={api} configured={configured} />
        )}
        {nodeId === 'sceneGenerator' && (
          <GeneratorInspector wf={wf} api={api} configured={configured} settings={settings} onOpenSettings={onOpenSettings} />
        )}
        {nodeId === 'resultAuditor' && <AuditInspector wf={wf} />}
        {nodeId === 'targetedRepair' && (
          <RepairInspector wf={wf} api={api} configured={configured} settings={settings} onOpenSettings={onOpenSettings} />
        )}
      </div>
    </aside>
  );
}

function subtitleFor(id: WorkflowNodeId): string {
  switch (id) {
    case 'referenceInput':
      return '参考图 1–5 张：决定视觉风格，不迁移商品身份';
    case 'productInput':
      return '同一商品 2–3 张多角度照片：决定商品身份';
    case 'recipeExtractor':
      return '12 个视觉字段 + 证据；确认后才能生成';
    case 'identityLock':
      return '模型候选必须逐条确认；仅已确认项成为硬约束';
    case 'sceneGenerator':
      return 'Prompt 由结构化配方单向编译，不可反向覆盖';
    case 'resultAuditor':
      return '身份 40% / 配方 30% / 任务 20% / 技术 10%';
    case 'targetedRepair':
      return '每件商品最多一次，仅返回受限 Patch';
  }
}

function ReferenceInputs({
  wf,
  api,
  configured,
}: {
  wf: SingleItemWorkflow | null;
  api: WorkflowApi;
  configured: boolean;
}) {
  const images = wf?.referenceImages ?? [];
  return (
    <>
      <RunDisabledNote configured={configured} />
      <ImageUploader
        images={images}
        setImages={(imgs) => api.setReferenceImages(imgs)}
        min={LIMITS.referenceImagesMin}
        max={LIMITS.referenceImagesMax}
        label="参考图"
      />
      <label className="field">
        <span>场景图用途说明（可选）</span>
        <input
          type="text"
          value={wf?.taskPurpose ?? ''}
          placeholder="如：电商详情页首屏场景图，浅色背景"
          onChange={(e) => api.setTaskPurpose(e.target.value)}
          data-testid="inspector-task-purpose"
        />
      </label>
    </>
  );
}

function ProductInputs({
  wf,
  api,
  configured,
}: {
  wf: SingleItemWorkflow | null;
  api: WorkflowApi;
  configured: boolean;
}) {
  const images = wf?.productImages ?? [];
  return (
    <>
      <RunDisabledNote configured={configured} />
      <ImageUploader
        images={images}
        setImages={(imgs) => api.setProductImages(imgs)}
        min={LIMITS.identityImagesMin}
        max={LIMITS.identityImagesMax}
        label="商品多角度图"
      />
      <div className="hint">图片分组由你显式建立，系统不会自动判定照片归属。</div>
    </>
  );
}

function RecipeInspector({
  wf,
  api,
  configured,
}: {
  wf: SingleItemWorkflow | null;
  api: WorkflowApi;
  configured: boolean;
}) {
  const recipe = wf?.recipe;
  const busy = api.busy;

  if (!recipe) {
    const canRun =
      configured &&
      (wf?.referenceImages.length ?? 0) >= LIMITS.referenceImagesMin &&
      !busy;
    return (
      <>
        <RunDisabledNote configured={configured} />
        <p className="hint">
          上传参考图后运行此节点，模型将输出 12 个视觉字段与图像证据。图片中的文字、URL、二维码只作为被分析内容，不会被执行。
        </p>
        <div>
          <button
            type="button"
            className="btn primary"
            disabled={!canRun}
            onClick={() => api.runAnalyze()}
            data-testid="inspector-run-recipe"
          >
            {busy ? <><span className="spinner" /> 分析中…</> : '提取视觉配方'}
          </button>
          {(wf?.referenceImages.length ?? 0) < 1 && (
            <p className="hint err" style={{ marginTop: 8 }}>请先在“参考图”节点上传至少 1 张参考图。</p>
          )}
          {api.actionError && <p className="hint err" style={{ marginTop: 8 }}>{api.actionError}</p>}
        </div>
      </>
    );
  }

  if (wf && !wf.recipeConfirmed) {
    const avg = recipe.fields.reduce((s, f) => s + f.confidence, 0) / recipe.fields.length;
    return (
      <>
        <div className="okbox" data-testid="recipe-gate">
          请确认迁移边界：只迁移商品无关、可描述的构图/光线/色彩/背景/氛围规律，不迁移 Logo、人物、水印或受保护内容。
        </div>
        <div className="kv-list">
          <span className="k">平均置信度</span>
          <span>{pct(avg)}</span>
        </div>
        <div>
          {recipe.fields.map((f) => (
            <div className="recipe-field" key={f.key}>
              <div className="k">
                {RECIPE_FIELD_LABELS[f.key]}
                <small>{f.key}</small>
              </div>
              <div>
                <div>{f.value}</div>
                <div className="confbar"><i style={{ width: `${Math.round(f.confidence * 100)}%` }} /></div>
                <EvidenceView evidence={f.evidence} />
              </div>
            </div>
          ))}
        </div>
        <RuleGroups recipe={recipe} />
        {api.actionError && <div className="errorbox">{api.actionError}</div>}
        <div className="inspector-foot" style={{ padding: 0, border: 'none' }}>
          <button type="button" className="btn primary" onClick={() => api.confirmRecipe()} data-testid="inspector-confirm-recipe">
            确认视觉配方（第一道人工闸门）
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <span className="badge passed">已确认</span>
      <div className="hint">确认于 {new Date(recipe.confirmedAt!).toLocaleString()}</div>
      <div>
        {recipe.fields.map((f) => (
          <div className="recipe-field" key={f.key}>
            <div className="k">{RECIPE_FIELD_LABELS[f.key]}</div>
            <div>
              <div>{f.value}</div>
              <EvidenceView evidence={f.evidence} />
            </div>
          </div>
        ))}
      </div>
      <RuleGroups recipe={recipe} />
    </>
  );
}

function RuleGroups({ recipe }: { recipe: NonNullable<SingleItemWorkflow['recipe']> }) {
  return (
    <div className="groups">
      <div className="group required">
        <h4>必须保持</h4>
        <ul>{recipe.required.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </div>
      <div className="group variable">
        <h4>允许变化</h4>
        <ul>{recipe.variable.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </div>
      <div className="group forbidden">
        <h4>禁止出现</h4>
        <ul>{recipe.forbidden.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </div>
    </div>
  );
}

function IdentityInspector({
  wf,
  api,
  configured,
}: {
  wf: SingleItemWorkflow | null;
  api: WorkflowApi;
  configured: boolean;
}) {
  if (!wf?.recipeConfirmed) {
    return <p className="hint">请先确认视觉配方，再提取商品身份候选。</p>;
  }
  const features = wf.identityFeatures;
  if (wf.identityConfirmed) {
    const hard = hardConstraints(features);
    return (
      <>
        <span className="badge passed">{hard.length > 0 ? '硬约束已锁定' : '已跳过（无硬约束）'}</span>
        {hard.length === 0 && (
          <div className="readonly-note">本商品未锁定身份硬约束直接生成，风险由你承担。</div>
        )}
        {hard.map((f) => (
          <div key={f.id} className="card">
            <div className="result-head">
              <span className="badge confirmed">{IDENTITY_CATEGORY_LABELS[f.category]}</span>
              <span className="badge plain major">{f.severityIfViolated}</span>
            </div>
            <div>{f.statement}</div>
            <EvidenceView evidence={f.evidence} />
          </div>
        ))}
      </>
    );
  }

  if (features.length === 0) {
    const canRun =
      configured && (wf.productImages.length >= 2) && !api.busy;
    return (
      <>
        <RunDisabledNote configured={configured} />
        <p className="hint">身份特征一律是候选，必须逐条确认；模型推测不会自动成为事实。</p>
        <button type="button" className="btn primary" disabled={!canRun} onClick={() => api.runAnalyze()} data-testid="inspector-run-identity">
          {api.busy ? <><span className="spinner" /> 分析中…</> : '提取候选身份特征'}
        </button>
        {wf.productImages.length < 2 && <p className="hint err" style={{ marginTop: 8 }}>请先上传 2–3 张商品多角度图。</p>}
      </>
    );
  }

  const confirmed = features.filter((f) => f.status === 'confirmed').length;
  const pending = features.filter((f) => f.status === 'pending').length;
  return (
    <>
      <div className="okbox" data-testid="identity-gate">
        逐条确认或驳回候选；仅“已确认”特征进入生成 Prompt 的硬约束。
      </div>
      <div className="hint">候选 {features.length} · 已确认 {confirmed} · 待处理 {pending}</div>
      {features.map((f) => (
        <div key={f.id} className="card">
          <div className="result-head">
            <span className="badge plain">{IDENTITY_CATEGORY_LABELS[f.category]}</span>
            <span className={`badge plain ${f.status === 'confirmed' ? 'confirmed' : f.status === 'rejected' ? 'rejected' : 'pending'}`}>
              {f.status === 'confirmed' ? '已确认' : f.status === 'rejected' ? '已驳回' : '待确认'}
            </span>
          </div>
          <div style={{ margin: '4px 0' }}>{f.statement}</div>
          <EvidenceView evidence={f.evidence} />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn sm"
              disabled={f.status === 'confirmed'}
              onClick={() => api.setFeature(f.id, 'confirmed')}
              data-testid={`feature-confirm-${f.id}`}
            >
              确认
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={f.status === 'rejected'}
              onClick={() => api.setFeature(f.id, 'rejected')}
              data-testid={`feature-reject-${f.id}`}
            >
              驳回
            </button>
          </div>
        </div>
      ))}
      <div className="inspector-foot" style={{ padding: 0, border: 'none' }}>
        <button type="button" className="btn danger" onClick={() => api.skipIdentityWithRisk()} data-testid="inspector-skip-identity">
          跳过身份锁定（无硬约束，自担风险）
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => api.finishIdentityLock()}
          disabled={pending > 0}
          data-testid="inspector-finish-identity"
        >
          完成身份锁定
        </button>
      </div>
    </>
  );
}

function GeneratorInspector({
  wf,
  api,
  configured,
  settings,
  onOpenSettings,
}: {
  wf: SingleItemWorkflow | null;
  api: WorkflowApi;
  configured: boolean;
  settings: ModelSettings | null;
  onOpenSettings: () => void;
}) {
  const compiled = useMemo(() => {
    if (wf?.recipe && wf.recipeConfirmed) {
      try {
        return compilePrompt(wf.recipe, wf.identityFeatures, wf.taskPurpose);
      } catch {
        return null;
      }
    }
    return null;
  }, [wf]);
  const budget = estimateCallBudget();
  const last = wf?.attempts[wf.attempts.length - 1];

  if (!wf?.identityConfirmed) {
    return <p className="hint">请先完成视觉配方确认与身份锁定，Prompt 将自动编译。</p>;
  }

  return (
    <>
      <RunDisabledNote configured={configured} />
      <div className="kv-list">
        <span className="k">调用预算</span>
        <span>预计 {budget.expected} 次 · 最坏 {budget.worst} 次（含一次修复）</span>
        <span className="k">已用调用</span>
        <span>{wf.callsUsed} 次</span>
        <span className="k">图片 Endpoint</span>
        <span>{settings?.imageEndpoint ? '已配置' : '未配置（无法生成图片）'}</span>
      </div>
      {compiled && (
        <details className="tech-details" open>
          <summary>编译后的正向 Prompt（只读，来源可追溯）</summary>
          <pre data-testid="compiled-positive">{compiled.positivePrompt}</pre>
          <summary style={{ marginTop: 8 }}>负向约束</summary>
          <pre>{compiled.negativePrompt}</pre>
        </details>
      )}
      {!configured && (
        <button type="button" className="btn" onClick={onOpenSettings}>配置模型</button>
      )}
      <button
        type="button"
        className="btn primary"
        disabled={!configured || !settings?.imageEndpoint || !!api.busy || !!last?.image}
        onClick={() => api.runGenerate()}
        data-testid="inspector-generate"
      >
        {api.busy === 'generating' ? <><span className="spinner" /> 正在生成…</> : '运行工作流（生成并自动验收）'}
      </button>
      {configured && !settings?.imageEndpoint && (
        <p className="hint err">请在模型设置中填写图片生成 Endpoint。</p>
      )}
      {api.actionError && <div className="errorbox">{api.actionError}</div>}
    </>
  );
}

function AuditInspector({ wf }: { wf: SingleItemWorkflow | null }) {
  const last = wf?.attempts[wf.attempts.length - 1];
  const audit = last?.audit;
  if (!audit) {
    return <p className="hint">场景图生成后将自动进行四维验收，这里显示分项分数、问题与证据。</p>;
  }
  return (
    <>
      <div className="result-head">
        <span className={`badge ${audit.status === 'passed' ? 'passed' : audit.status === 'failed' ? 'failed' : audit.status === 'warning' ? 'warning' : 'needs-review'}`}>
          {audit.status === 'passed' ? '通过' : audit.status === 'failed' ? '未通过' : audit.status === 'warning' ? '警告' : '需人工确认'}
        </span>
        <span>综合 {audit.compositeScore}</span>
      </div>
      <div className="scores">
        <div className="score"><div className="n">{audit.identityScore}</div><div className="l">商品身份 40%</div></div>
        <div className="score"><div className="n">{audit.recipeScore}</div><div className="l">视觉配方 30%</div></div>
        <div className="score"><div className="n">{audit.taskScore}</div><div className="l">场景任务 20%</div></div>
        <div className="score"><div className="n">{audit.technicalScore}</div><div className="l">技术质量 10%</div></div>
      </div>
      {audit.criticalViolation && <div className="errorbox">触发一票否决：存在身份/Logo/材质/虚构文字等严重问题。</div>}
      {audit.insufficientEvidence && <div className="readonly-note">模型自评证据不足，结论需人工确认。</div>}
      <p className="hint">{audit.statusReason}</p>
      <div>
        <h4 style={{ fontSize: 13, margin: '6px 0' }}>问题清单（{audit.issues.length}）</h4>
        {audit.issues.length === 0 && <div className="hint">未列出问题。</div>}
        {audit.issues.map((iss, i) => (
          <div key={i} className="issue">
            <div className="result-head">
              <span className="badge plain">{AUDIT_DIMENSION_LABELS[iss.dimension] ?? iss.dimension}</span>
              <span className={`badge plain ${iss.severity}`}>{iss.severity}</span>
              <span className="hint">{pct(iss.confidence)}</span>
            </div>
            <div>{iss.statement}</div>
            <EvidenceView evidence={iss.evidence} />
          </div>
        ))}
      </div>
    </>
  );
}

function RepairInspector({
  wf,
  api,
  configured,
  settings,
  onOpenSettings,
}: {
  wf: SingleItemWorkflow | null;
  api: WorkflowApi;
  configured: boolean;
  settings: ModelSettings | null;
  onOpenSettings: () => void;
}) {
  const v2 = wf?.attempts.find((a) => a.version === 2);
  const pendingRepair = v2?.repair && !v2.repair.confirmedAt;
  const audit = wf?.attempts[wf.attempts.length - 1]?.audit;

  if (wf?.repairUsed) {
    return (
      <>
        <span className="badge passed">修复已使用（每件仅限一次）</span>
        {v2?.repair && (
          <div className="card">
            <div className="hint">修复理由</div>
            <div>{v2.repair.reason}</div>
            {v2.repair.addedNegative.length > 0 && (
              <>
                <div className="hint" style={{ marginTop: 8 }}>新增负向约束</div>
                <ul>{v2.repair.addedNegative.map((s, i) => <li key={i} className="hint">{s}</li>)}</ul>
              </>
            )}
            <div className="hint" style={{ marginTop: 8 }}>确认于 {new Date(v2.repair.confirmedAt!).toLocaleString()}</div>
          </div>
        )}
      </>
    );
  }

  if (wf?.state === 'paused' && pendingRepair) {
    return (
      <>
        <div className="readonly-note" data-testid="repair-gate">
          {v2!.repair!.highRisk
            ? '高风险修复（涉及形态/Logo/材质/虚构文字）：必须人工确认后才会重新生成。'
            : '低风险修复方案待确认。'}
        </div>
        <div className="card">
          <div className="hint">修复理由</div>
          <div>{v2!.repair!.reason}</div>
          {v2!.repair!.positivePromptOverride && (
            <details className="tech-details" style={{ marginTop: 8 }}>
              <summary>新正向 Prompt（保留全部身份硬约束）</summary>
              <pre>{v2!.repair!.positivePromptOverride}</pre>
            </details>
          )}
          {v2!.repair!.addedNegative.length > 0 && (
            <>
              <div className="hint" style={{ marginTop: 8 }}>新增负向约束</div>
              <ul>{v2!.repair!.addedNegative.map((s, i) => <li key={i} className="hint">{s}</li>)}</ul>
            </>
          )}
        </div>
        <div className="inspector-foot" style={{ padding: 0, border: 'none' }}>
          <button type="button" className="btn primary" disabled={!configured} onClick={() => api.applyRepair()} data-testid="inspector-apply-repair">
            确认并重新生成 V2
          </button>
        </div>
      </>
    );
  }

  if (audit?.status === 'failed') {
    return (
      <>
        <RunDisabledNote configured={configured} />
        <p className="hint">验收未通过，可生成一次定向修复方案；模型只能调整场景相关描述或补充负向约束，不能改写已确认身份。</p>
        {!configured && <button type="button" className="btn" onClick={onOpenSettings}>配置模型</button>}
        <button
          type="button"
          className="btn primary"
          disabled={!configured || !settings?.imageEndpoint || !!api.busy}
          onClick={() => api.requestRepair()}
          data-testid="inspector-request-repair"
        >
          {api.busy === 'repair-propose' ? <><span className="spinner" /> 生成修复方案…</> : '生成定向修复方案'}
        </button>
        {api.actionError && <div className="errorbox">{api.actionError}</div>}
      </>
    );
  }

  return <p className="hint">定向修复仅在验收失败后启用，每件商品最多一次。</p>;
}

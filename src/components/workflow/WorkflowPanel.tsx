import { useMemo, useState } from 'react';
import { ImageUploader } from '../ImageUploader';
import { EvidenceView } from '../EvidenceView';
import { NotConfiguredGate } from '../Common';
import {
  IDENTITY_CATEGORY_LABELS,
  LIMITS,
  RECIPE_FIELD_LABELS,
} from '../../shared/constants';
import type { AuditResult, IdentityFeature, ModelSettings, UploadedImage } from '../../shared/types';
import { isImageConfigured } from '../../shared/security';
import { useSingleItemWorkflow } from '../../hooks/useSingleItemWorkflow';
import { compilePrompt } from '../../workflow/promptCompiler';
import { estimateCallBudget, WORKFLOW_NODE_IDS, WORKFLOW_NODE_LABELS, BATCH_STATE_LABELS, type WorkflowNodeId } from '../../workflow/workflowConstants';
import type { GenerationAttempt, SingleItemWorkflow } from '../../workflow/workflowTypes';

type Props = {
  settings: ModelSettings | null;
  onOpenSettings: () => void;
};

export function WorkflowPanel({ settings, onOpenSettings }: Props) {
  const [referenceImages, setReferenceImages] = useState<UploadedImage[]>([]);
  const [productImages, setProductImages] = useState<UploadedImage[]>([]);
  const [taskPurpose, setTaskPurpose] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const wfApi = useSingleItemWorkflow();
  const { wf, busy, actionError, highRisk } = wfApi;
  const budget = useMemo(() => estimateCallBudget(), []);

  if (!settings) {
    return (
      <div className="panel">
        <h2>单件工作流（阶段2）</h2>
        <p className="desc">固定线性流程：参考图/商品输入 → 配方提取 → 身份锁定 → 场景生成 → 结果验收 →（失败时）定向修复一次。需配置模型后使用。</p>
        <NotConfiguredGate onOpenSettings={onOpenSettings} />
      </div>
    );
  }

  function createAndAnalyze() {
    setFormError(null);
    const ok = wfApi.start({ referenceImages, productImages, taskPurpose });
    if (!ok) return;
    void wfApi.runAnalyze(settings);
  }

  const canCreate =
    referenceImages.length >= LIMITS.referenceImagesMin &&
    referenceImages.length <= LIMITS.referenceImagesMax &&
    productImages.length >= LIMITS.identityImagesMin &&
    productImages.length <= LIMITS.identityImagesMax;

  return (
    <div className="panel">
      <h2>单件工作流（阶段2 · 固定主干）</h2>
      <p className="desc">
        一件商品走完全流程：两道人工闸门（确认视觉配方、确认高风险修复），最终 Prompt 只读、不可反向覆盖已确认结构；每件最多定向修复一次。
      </p>

      {!wf && (
        <div data-testid="wf-setup">
          <h4>① 参考图（决定视觉风格，1-5 张）</h4>
          <ImageUploader images={referenceImages} setImages={setReferenceImages} min={LIMITS.referenceImagesMin} max={LIMITS.referenceImagesMax} label="参考图" />
          <h4 style={{ marginTop: 14 }}>② 商品多角度图（决定商品身份，2-3 张）</h4>
          <ImageUploader images={productImages} setImages={setProductImages} min={LIMITS.identityImagesMin} max={LIMITS.identityImagesMax} label="商品图" />
          <h4 style={{ marginTop: 14 }}>③ 场景图用途（可选）</h4>
          <input
            type="text"
            className="textinput"
            placeholder="如：电商详情页首屏场景图，浅色背景"
            value={taskPurpose}
            onChange={(e) => setTaskPurpose(e.target.value)}
            data-testid="task-purpose-input"
            style={{ width: '100%' }}
          />
          <div className="okbox" style={{ marginTop: 12 }} data-testid="call-budget">
            调用预算：预计 {budget.expected} 次（配方/身份/生成/验收各 1），最坏 {budget.worst} 次（追加修复 1 + 重生成 1 + 重验收 1）。
          </div>
          {formError && <p className="hint err">{formError}</p>}
          {!canCreate && <p className="hint">请先满足参考图与商品图数量要求。</p>}
          <button type="button" className="btn primary" style={{ marginTop: 12 }} disabled={!canCreate || busy !== null} onClick={createAndAnalyze} data-testid="wf-create">
            {busy === 'analyzing' ? <><span className="spinner" /> 正在分析配方与身份…</> : '创建并开始分析'}
          </button>
        </div>
      )}

      {wf && (
        <div data-testid="wf-run">
          <Stepper wf={wf} />
          <div className="row" style={{ margin: '10px 0', gap: 10 }}>
            <span className="badge pending">状态：{BATCH_STATE_LABELS[wf.state]}</span>
            <span className="hint">已用模型调用 {wf.callsUsed} 次（预算 {budget.expected}/{budget.worst}）</span>
            <button type="button" className="btn" onClick={() => void wfApi.reset()} data-testid="wf-reset">新建/清空</button>
          </div>

          {wf.state === 'interrupted' && (
            <div className="okbox" style={{ background: '#fff4e5' }} data-testid="wf-interrupted">
              检测到流程在进行中被刷新/中断。系统不会假装它仍在运行。你可以回到草稿继续，或清空新建。
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn" onClick={wfApi.resume}>回到草稿</button>
              </div>
            </div>
          )}

          {(actionError || wf.lastError) && (
            <div className="okbox" style={{ background: '#fdecea' }} data-testid="wf-error">
              {actionError || wf.lastError?.message}
              {wf.lastError?.diagnostics?.errorClass && (
                <div className="hint">错误分类：{wf.lastError.diagnostics.errorClass}</div>
              )}
            </div>
          )}

          {!wf.recipe && (
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void wfApi.runAnalyze(settings)} data-testid="wf-analyze">
              {busy === 'analyzing' ? <><span className="spinner" /> 分析中…</> : '运行配方 + 身份分析'}
            </button>
          )}

          {wf.recipe && !wf.recipeConfirmed && <RecipeGate wf={wf} onConfirm={wfApi.confirmRecipe} />}

          {wf.recipeConfirmed && !wf.identityConfirmed && (
            <IdentityGate wf={wf} onSetFeature={wfApi.setFeature} onFinish={wfApi.finishIdentityLock} />
          )}

          {wf.recipeConfirmed && wf.identityConfirmed && wf.attempts.length === 0 && (
            <GenerateGate
              wf={wf}
              settings={settings}
              busy={busy}
              onGenerate={() => void wfApi.generate(settings)}
            />
          )}

          {wf.attempts.map((att) => (
            <AttemptCard key={att.id} attempt={att} />
          ))}

          {wf.state === 'paused' && (
            <RepairGate
              wf={wf}
              highRisk={highRisk}
              busy={busy}
              onApply={() => void wfApi.applyRepair(settings)}
            />
          )}

          {(wf.state === 'failed' || wf.state === 'warning' || wf.state === 'needs-review') && (
            <TerminalActions wf={wf} busy={busy} highRisk={highRisk} onAccept={wfApi.accept} onRepair={() => void wfApi.requestRepair(settings)} />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- 步骤条 ------------------------------- */

function nodeStatus(wf: SingleItemWorkflow, id: WorkflowNodeId): 'done' | 'active' | 'todo' | 'blocked' {
  const latest = wf.attempts[wf.attempts.length - 1];
  switch (id) {
    case 'referenceInput':
    case 'productInput':
      return 'done';
    case 'recipeExtractor':
      return wf.recipeConfirmed ? 'done' : wf.recipe ? 'active' : 'todo';
    case 'identityLock':
      return wf.identityConfirmed ? 'done' : wf.recipeConfirmed ? 'active' : 'todo';
    case 'sceneGenerator':
      return latest?.image ? 'done' : wf.identityConfirmed ? 'active' : 'todo';
    case 'resultAuditor':
      return latest?.audit ? 'done' : latest?.image ? 'active' : 'todo';
    case 'targetedRepair':
      return wf.repairUsed ? 'done' : wf.state === 'failed' ? 'active' : 'blocked';
  }
}

function Stepper({ wf }: { wf: SingleItemWorkflow }) {
  return (
    <div className="stepper" data-testid="wf-stepper">
      {WORKFLOW_NODE_IDS.map((id, i) => {
        const st = nodeStatus(wf, id);
        return (
          <div key={id} className={`step ${st}`} data-testid={`step-${id}`}>
            <div className="stepno">{st === 'done' ? '✓' : i + 1}</div>
            <div className="steplabel">{WORKFLOW_NODE_LABELS[id]}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------- 闸门一：配方 ----------------------------- */

function RecipeGate({ wf, onConfirm }: { wf: SingleItemWorkflow; onConfirm: () => void }) {
  const recipe = wf.recipe!;
  return (
    <div className="card" data-testid="gate-recipe">
      <div className="result-head">
        <strong>第一道闸门：确认视觉配方</strong>
        <span className="badge pending">待你确认</span>
      </div>
      <p className="hint">只迁移商品无关的构图/光线/色彩/背景/氛围规律；不复制 Logo、人物、水印或受保护内容。确认后才能生成。</p>
      <div>
        {recipe.fields.map((f) => (
          <div className="recipe-field" key={f.key}>
            <div className="k">{RECIPE_FIELD_LABELS[f.key] ?? f.key}<small>{f.key}</small></div>
            <div>
              <div>{f.value}</div>
              <div className="confbar"><i style={{ width: `${Math.round(f.confidence * 100)}%` }} /></div>
              <EvidenceView evidence={f.evidence} />
            </div>
          </div>
        ))}
      </div>
      <div className="groups">
        <div className="group required"><h4>必须保持</h4><StringList items={recipe.required} /></div>
        <div className="group variable"><h4>允许变化</h4><StringList items={recipe.variable} /></div>
        <div className="group forbidden"><h4>禁止出现</h4><StringList items={recipe.forbidden} /></div>
      </div>
      <button type="button" className="btn primary" onClick={onConfirm} data-testid="confirm-recipe">确认配方，进入身份锁定</button>
    </div>
  );
}

/* ----------------------------- 闸门：身份 ----------------------------- */

function IdentityGate({
  wf,
  onSetFeature,
  onFinish,
}: {
  wf: SingleItemWorkflow;
  onSetFeature: (id: string, status: 'confirmed' | 'rejected') => void;
  onFinish: () => void;
}) {
  const features = wf.identityFeatures;
  const confirmedCount = features.filter((f) => f.status === 'confirmed').length;
  return (
    <div className="card" data-testid="gate-identity">
      <div className="result-head">
        <strong>身份锁定：候选特征默认 pending</strong>
        <span className="badge pending">需你核对</span>
      </div>
      <p className="hint">模型推测不会自动成为事实。确认后的特征才作为硬约束进入 Prompt；跳过身份锁定将缺少硬约束、风险自负。</p>
      {features.length === 0 && <div className="hint">模型未提出候选身份特征。</div>}
      {features.map((f: IdentityFeature) => (
        <div key={f.id} className="feat-row" data-testid={`feat-${f.id}`}>
          <div>
            <span className="badge">{IDENTITY_CATEGORY_LABELS[f.category] ?? f.category}</span>
            <span style={{ marginLeft: 8 }}>{f.statement}</span>
            <small className="hint">（违反严重度 {f.severityIfViolated}）</small>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className={`badge ${f.status === 'confirmed' ? 'confirmed' : f.status === 'rejected' ? 'rejected' : 'pending'}`}>
              {f.status === 'confirmed' ? '已确认' : f.status === 'rejected' ? '已驳回' : '待确认'}
            </span>
            <button type="button" className="btn sm" onClick={() => onSetFeature(f.id, 'confirmed')}>确认</button>
            <button type="button" className="btn sm" onClick={() => onSetFeature(f.id, 'rejected')}>驳回</button>
          </div>
        </div>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button type="button" className="btn primary" onClick={onFinish} data-testid="finish-identity">
          完成身份锁定（已确认 {confirmedCount} 条）
        </button>
        <button type="button" className="btn" onClick={onFinish} data-testid="skip-identity">跳过（无硬约束，自担风险）</button>
      </div>
    </div>
  );
}

/* ----------------------------- 生成前只读 Prompt ----------------------------- */

function GenerateGate({
  wf,
  settings,
  busy,
  onGenerate,
}: {
  wf: SingleItemWorkflow;
  settings: ModelSettings;
  busy: string | null;
  onGenerate: () => void;
}) {
  const compiled = useMemo(
    () => (wf.recipe ? compilePrompt(wf.recipe, wf.identityFeatures, wf.taskPurpose) : null),
    [wf],
  );
  const hasImageEndpoint = isImageConfigured(settings);
  return (
    <div className="card" data-testid="gate-generate">
      <div className="result-head"><strong>最终 Prompt（只读）</strong><span className="badge confirmed">结构已锁定</span></div>
      {compiled && (
        <>
          <h4>正向 Prompt</h4>
          <pre className="promptbox" data-testid="compiled-positive">{compiled.positivePrompt}</pre>
          <h4>负向 Prompt</h4>
          <pre className="promptbox" data-testid="compiled-negative">{compiled.negativePrompt}</pre>
        </>
      )}
      {!hasImageEndpoint && (
        <p className="hint err">尚未配置图片生成 Endpoint，请在“模型设置”中填写（如 Seedream 接入点/模型 ID）。</p>
      )}
      <button type="button" className="btn primary" disabled={!hasImageEndpoint || busy !== null} onClick={onGenerate} data-testid="generate-btn">
        {busy === 'generating' ? <><span className="spinner" /> 生成并自动验收中（可能较慢）…</> : '生成场景图并自动验收'}
      </button>
    </div>
  );
}

/* ----------------------------- 单次尝试（版本） ----------------------------- */

function AttemptCard({ attempt }: { attempt: GenerationAttempt }) {
  return (
    <div className="card" data-testid={`attempt-${attempt.version}`}>
      <div className="result-head">
        <strong>版本 {attempt.version}{attempt.version === 2 ? '（定向修复后）' : ''}</strong>
        <span className={`badge ${attempt.audit?.status === 'passed' ? 'confirmed' : attempt.audit?.status === 'failed' ? 'rejected' : 'pending'}`}>
          {attempt.audit ? statusLabel(attempt.audit.status) : attempt.status}
        </span>
      </div>
      {attempt.image && (
        <img className="genimg" src={attempt.image.dataUri} alt={`生成版本${attempt.version}`} data-testid={`genimg-${attempt.version}`} />
      )}
      {attempt.status === 'generation-failed' && <div className="hint err">图片生成失败。</div>}
      {attempt.audit && <AuditDetail audit={attempt.audit} />}
    </div>
  );
}

function statusLabel(s: string): string {
  return { passed: '通过', warning: '警告', failed: '失败', 'needs-review': '需人工确认' }[s] ?? s;
}

function AuditDetail({ audit }: { audit: AuditResult }) {
  const scores: Array<[string, number]> = [
    ['商品身份', audit.identityScore],
    ['视觉配方', audit.recipeScore],
    ['任务用途', audit.taskScore],
    ['技术质量', audit.technicalScore],
  ];
  return (
    <div data-testid="audit-detail">
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        {scores.map(([k, v]) => (
          <div key={k} style={{ minWidth: 130 }}>
            <div className="hint">{k} {v}</div>
            <div className="confbar"><i style={{ width: `${v}%` }} /></div>
          </div>
        ))}
        <div className="hint">综合 {audit.compositeScore} · 模型置信度 {(audit.modelConfidence * 100).toFixed(0)}%</div>
      </div>
      {audit.criticalViolation && <div className="hint err">触发一票否决（critical）。</div>}
      {audit.insufficientEvidence && <div className="hint">证据不足，结论为 needs-review，未强行判断。</div>}
      <div className="hint">{audit.statusReason}</div>
      {audit.issues.map((iss, i) => (
        <div key={i} className="issue">
          <span className={`badge ${iss.severity === 'critical' ? 'rejected' : 'pending'}`}>{iss.dimension}/{iss.severity}</span>
          <span style={{ marginLeft: 8 }}>{iss.statement}</span>
          <EvidenceView evidence={iss.evidence} />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------- 修复闸门 ----------------------------- */

function RepairGate({
  wf,
  highRisk,
  busy,
  onApply,
}: {
  wf: SingleItemWorkflow;
  highRisk: boolean;
  busy: string | null;
  onApply: () => void;
}) {
  const v2 = wf.attempts.find((a) => a.version === 2);
  const repair = v2?.repair;
  if (!repair) return null;
  const base = wf.attempts.find((a) => a.version === 1);
  const newPositive = repair.positivePromptOverride?.trim() || base?.prompt.positivePrompt || '';
  const newNegative = [base?.prompt.negativePrompt ?? '', ...repair.addedNegative.map((s) => `避免：${s}`)].filter(Boolean).join('；');
  return (
    <div className="card" data-testid="gate-repair">
      <div className="result-head">
        <strong>第二道闸门：定向修复方案</strong>
        {highRisk ? <span className="badge rejected">高风险·需你确认</span> : <span className="badge pending">待确认</span>}
      </div>
      {highRisk && <p className="hint err">涉及形态/Logo/材质/虚构文字等身份级问题，默认暂停。请确认修复不会改变商品本体；身份硬约束不可被模型改写。</p>}
      <p><b>修改理由：</b>{repair.reason}</p>
      <div className="hint">受影响字段：{repair.affectedFields.join('、') || '（未标注）'}</div>
      <h4>修复后正向 Prompt（只读）</h4>
      <pre className="promptbox">{newPositive}</pre>
      <h4>修复后负向 Prompt（只读）</h4>
      <pre className="promptbox">{newNegative}</pre>
      <button type="button" className="btn primary" disabled={busy !== null} onClick={onApply} data-testid="apply-repair">
        {busy === 'repair-apply' ? <><span className="spinner" /> 重新生成并验收中…</> : '确认并重新生成（仅此一次）'}
      </button>
    </div>
  );
}

/* ----------------------------- 终态动作 ----------------------------- */

function TerminalActions({
  wf,
  busy,
  highRisk: _highRisk,
  onAccept,
  onRepair,
}: {
  wf: SingleItemWorkflow;
  busy: string | null;
  highRisk: boolean;
  onAccept: () => void;
  onRepair: () => void;
}) {
  const canRepair = wf.state === 'failed' && !wf.repairUsed;
  return (
    <div className="row" style={{ gap: 10, marginTop: 10 }} data-testid="terminal-actions">
      {(wf.state === 'warning' || wf.state === 'needs-review') && (
        <button type="button" className="btn" onClick={onAccept} data-testid="accept-btn">人工接受为通过</button>
      )}
      {canRepair && (
        <button type="button" className="btn primary" disabled={busy !== null} onClick={onRepair} data-testid="request-repair">
          {busy === 'repair-propose' ? <><span className="spinner" /> 生成修复方案中…</> : '生成定向修复方案'}
        </button>
      )}
      {wf.state === 'failed' && wf.repairUsed && (
        <span className="hint err">已用完唯一一次定向修复，仍未通过；请调整素材/配方后新建。</span>
      )}
    </div>
  );
}

function StringList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return <div className="hint">（空）</div>;
  return <ul>{items.map((s, i) => <li key={i}>{s}</li>)}</ul>;
}

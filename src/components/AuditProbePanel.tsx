import { useState } from 'react';
import { ImageUploader } from './ImageUploader';
import { EvidenceView } from './EvidenceView';
import { DiagnosticsView } from './DiagnosticsView';
import { RawOutputView } from './RawOutputView';
import { ErrorOutcome, NotConfiguredGate } from './Common';
import { assembleAuditResult, visualRecipeSchema } from '../shared/schema';
import type {
  AuditResult,
  AuditStatus,
  ModelSettings,
  ProbeOutcome,
  UploadedImage,
  VisualRecipe,
} from '../shared/types';
import { buildAuditMessages } from '../model/prompts';
import { runProbe } from '../model/arkClient';

type Props = {
  settings: ModelSettings | null;
  latestRecipe: VisualRecipe | null;
  onOpenSettings: () => void;
};

const STATUS_TEXT: Record<AuditStatus, string> = {
  passed: '通过 passed',
  warning: '警告 warning',
  failed: '失败 failed',
  'needs-review': '需要人工确认 needs-review',
};

const DIM_LABELS: Record<string, string> = {
  identity: '商品身份 40%',
  recipe: '视觉配方 30%',
  task: '场景任务 20%',
  technical: '技术质量 10%',
};

export function AuditProbePanel({ settings, latestRecipe, onOpenSettings }: Props) {
  const [productImages, setProductImages] = useState<UploadedImage[]>([]);
  const [candidate, setCandidate] = useState<UploadedImage[]>([]);
  const [taskPurpose, setTaskPurpose] = useState('电商静物场景图');
  const [useLatest, setUseLatest] = useState(true);
  const [pastedRecipe, setPastedRecipe] = useState('');
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<ProbeOutcome<AuditResult> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  function resolveRecipe(): VisualRecipe | { error: string } {
    if (useLatest && latestRecipe) return latestRecipe;
    if (!useLatest) {
      if (!pastedRecipe.trim()) return { error: '请粘贴视觉配方 JSON' };
      try {
        const parsed = visualRecipeSchema.safeParse(JSON.parse(pastedRecipe));
        if (parsed.success) return parsed.data;
        return {
          error: `配方 JSON 未通过 Schema：${parsed.error.issues
            .map((i) => i.message)
            .join('；')}`,
        };
      } catch (e) {
        return { error: `配方 JSON 解析失败：${(e as Error).message}` };
      }
    }
    return { error: '尚无视觉配方：请先在 A 探针生成，或切换为粘贴配方 JSON' };
  }

  async function run() {
    setFormError(null);
    if (productImages.length < 1) {
      setFormError('请至少上传 1 张原始商品图');
      return;
    }
    if (candidate.length !== 1) {
      setFormError('请上传恰好 1 张待检查结果图');
      return;
    }
    const recipe = resolveRecipe();
    if ('error' in recipe) {
      setFormError(recipe.error);
      return;
    }
    setLoading(true);
    setOutcome(null);
    const messages = buildAuditMessages(productImages, candidate[0], recipe, taskPurpose);
    const result = await runProbe(
      'audit',
      settings,
      messages,
      (raw) => assembleAuditResult('product-1', raw),
    );
    setOutcome(result);
    setLoading(false);
  }

  if (!settings) {
    return (
      <div className="panel">
        <h2>C. 结果验收探针</h2>
        <p className="desc">上传原始商品图、视觉配方和一张待检查图，分别检查商品身份/视觉配方/任务用途/技术质量。严重错误一票否决，证据不足则 needs-review。</p>
        <NotConfiguredGate onOpenSettings={onOpenSettings} />
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>C. 结果验收探针</h2>
      <p className="desc">
        四维打分（身份40% / 配方30% / 任务20% / 技术10%）。任一严重错误（缺件、Logo 错误、明显变形、虚构文字、违反必须保持项）一票否决；
        关键区域不可辨认时输出 <b>needs-review</b>，不强行判断。最终状态由代码确定性计算。
      </p>

      <ImageUploader
        images={productImages}
        setImages={setProductImages}
        min={1}
        max={3}
        label="原始商品图"
      />
      <ImageUploader
        images={candidate}
        setImages={setCandidate}
        min={1}
        max={1}
        label="待检查结果图（1 张）"
      />

      <label className="field">
        <span>视觉配方来源</span>
        <div>
          <label style={{ marginRight: 16 }}>
            <input
              type="radio"
              checked={useLatest}
              onChange={() => setUseLatest(true)}
              disabled={!latestRecipe}
            />{' '}
            使用 A 探针最新结果 {latestRecipe ? `（${latestRecipe.name}）` : '（尚未生成）'}
          </label>
          <label>
            <input type="radio" checked={!useLatest} onChange={() => setUseLatest(false)} />{' '}
            粘贴配方 JSON
          </label>
        </div>
      </label>
      {!useLatest && (
        <label className="field">
          <span>视觉配方 JSON（需通过 VisualRecipe Schema）</span>
          <textarea
            value={pastedRecipe}
            onChange={(e) => setPastedRecipe(e.target.value)}
            placeholder='{"id":"...","name":"...","fields":[...12项...],"required":[],"variable":[],"forbidden":[]}'
          />
        </label>
      )}

      <label className="field">
        <span>任务用途</span>
        <input type="text" value={taskPurpose} onChange={(e) => setTaskPurpose(e.target.value)} />
      </label>

      {formError && <p className="hint err">{formError}</p>}
      <button type="button" className="btn primary" onClick={run} disabled={loading}>
        {loading ? (
          <>
            <span className="spinner" /> 正在验收…
          </>
        ) : (
          '运行结果验收探针'
        )}
      </button>

      <div style={{ marginTop: 14 }}>
        {outcome && !outcome.ok && <ErrorOutcome error={outcome} raw={outcome.raw} />}
        {outcome && outcome.ok && <AuditResultView result={outcome.data} />}
        {outcome && outcome.ok && (
          <>
            <DiagnosticsView diagnostics={outcome.raw.diagnostics} />
            <RawOutputView raw={outcome.raw} />
          </>
        )}
      </div>
    </div>
  );
}

function AuditResultView({ result }: { result: AuditResult }) {
  return (
    <div className="card" data-testid="audit-result">
      <div className="result-head">
        <span className={`badge big-status ${result.status}`} data-testid="audit-status">
          {STATUS_TEXT[result.status]}
        </span>
        {result.criticalViolation && <span className="badge critical">严重错误·一票否决</span>}
        {result.insufficientEvidence && (
          <span className="badge needs-review">证据不足·需人工确认</span>
        )}
        <span className="hint">判定依据：{result.statusReason}</span>
      </div>

      <div className="scores">
        <Score label={DIM_LABELS.identity} value={result.identityScore} />
        <Score label={DIM_LABELS.recipe} value={result.recipeScore} />
        <Score label={DIM_LABELS.task} value={result.taskScore} />
        <Score label={DIM_LABELS.technical} value={result.technicalScore} />
        <Score label="加权综合分" value={result.compositeScore} strong />
      </div>

      <div className="hint" style={{ marginBottom: 8 }}>
        模型自评置信度：{(result.modelConfidence * 100).toFixed(0)}%（阈值为待校准产品规则，非行业标准）
      </div>

      <h4 style={{ margin: '8px 0' }}>问题清单（{result.issues.length}）</h4>
      {result.issues.length === 0 && <div className="hint">模型未报告问题。</div>}
      {result.issues.map((issue, i) => (
        <div className="card" key={i}>
          <div>
            <span className={`badge ${issue.severity}`}>{issue.severity}</span>{' '}
            <b>{DIM_LABELS[issue.dimension] ?? issue.dimension}</b> — {issue.statement}
          </div>
          <EvidenceView evidence={issue.evidence} />
        </div>
      ))}
    </div>
  );
}

function Score({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="score">
      <div className="n" style={strong ? { color: 'var(--teal)' } : undefined}>
        {value.toFixed(1)}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}

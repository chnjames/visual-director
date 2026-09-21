import { useState } from 'react';
import { ImageUploader } from './ImageUploader';
import { EvidenceView } from './EvidenceView';
import { DiagnosticsView } from './DiagnosticsView';
import { RawOutputView } from './RawOutputView';
import { ErrorOutcome, NotConfiguredGate } from './Common';
import { LIMITS, RECIPE_FIELD_LABELS } from '../shared/constants';
import { assembleVisualRecipe } from '../shared/schema';
import type { ModelSettings, ProbeOutcome, UploadedImage, VisualRecipe } from '../shared/types';
import { buildRecipeMessages } from '../model/prompts';
import { runProbe } from '../model/arkClient';

type Props = {
  settings: ModelSettings | null;
  onOpenSettings: () => void;
  onRecipeProduced: (recipe: VisualRecipe) => void;
};

export function RecipeProbePanel({ settings, onOpenSettings, onRecipeProduced }: Props) {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<ProbeOutcome<VisualRecipe> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function run() {
    setFormError(null);
    if (images.length < LIMITS.referenceImagesMin || images.length > LIMITS.referenceImagesMax) {
      setFormError(`请上传 ${LIMITS.referenceImagesMin}-${LIMITS.referenceImagesMax} 张参考图`);
      return;
    }
    setLoading(true);
    setOutcome(null);
    const messages = buildRecipeMessages(images);
    const result = await runProbe('recipe', settings, messages, assembleVisualRecipe);
    setOutcome(result);
    if (result.ok) onRecipeProduced(result.data);
    setLoading(false);
  }

  if (!settings) {
    return (
      <div className="panel">
        <h2>A. 视觉配方探针</h2>
        <p className="desc">上传 1-5 张参考图，由 Seed 输出 12 字段视觉配方（含值、置信度、图像证据），严格通过 Schema 校验。不会声称恢复原始 Prompt。</p>
        <NotConfiguredGate onOpenSettings={onOpenSettings} />
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>A. 视觉配方探针</h2>
      <p className="desc">
        上传 1-5 张你拥有合法使用权的参考图，输出 12 字段视觉配方。每个字段包含值、置信度与图像证据；
        字段默认未锁定，需你确认后才进入工作流。
      </p>

      <ImageUploader
        images={images}
        setImages={setImages}
        min={LIMITS.referenceImagesMin}
        max={LIMITS.referenceImagesMax}
        label="参考图"
      />
      {formError && <p className="hint err">{formError}</p>}
      <button type="button" className="btn primary" onClick={run} disabled={loading}>
        {loading ? (
          <>
            <span className="spinner" /> 正在调用 Seed 提取配方…
          </>
        ) : (
          '运行视觉配方探针'
        )}
      </button>

      <div style={{ marginTop: 14 }}>
        {outcome && !outcome.ok && <ErrorOutcome error={outcome} raw={outcome.raw} />}
        {outcome && outcome.ok && <RecipeResult recipe={outcome.data} />}
        {outcome && outcome.ok && (
          <>
            <div className="okbox">✅ Schema 校验通过：12 个字段齐全，证据完整。</div>
            <DiagnosticsView diagnostics={outcome.raw.diagnostics} />
            <RawOutputView raw={outcome.raw} />
          </>
        )}
      </div>
    </div>
  );
}

function RecipeResult({ recipe }: { recipe: VisualRecipe }) {
  return (
    <div className="card" data-testid="recipe-result">
      <div className="result-head">
        <strong>{recipe.name}</strong>
        <span className="badge confirmed">VisualRecipe</span>
      </div>
      <div>
        {recipe.fields.map((f) => (
          <div className="recipe-field" key={f.key}>
            <div className="k">
              {RECIPE_FIELD_LABELS[f.key] ?? f.key}
              <small>{f.key}</small>
            </div>
            <div>
              <div>{f.value}</div>
              <div className="confbar">
                <i style={{ width: `${Math.round(f.confidence * 100)}%` }} />
              </div>
              <div className="hint">置信度 {(f.confidence * 100).toFixed(0)}%</div>
              <EvidenceView evidence={f.evidence} />
            </div>
          </div>
        ))}
      </div>
      <div className="groups">
        <div className="group required">
          <h4>必须保持</h4>
          <StringList items={recipe.required} />
        </div>
        <div className="group variable">
          <h4>允许变化</h4>
          <StringList items={recipe.variable} />
        </div>
        <div className="group forbidden">
          <h4>禁止出现</h4>
          <StringList items={recipe.forbidden} />
        </div>
      </div>
    </div>
  );
}

function StringList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return <div className="hint">（空）</div>;
  return (
    <ul>
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

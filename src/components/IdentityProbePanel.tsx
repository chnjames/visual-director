import { useState } from 'react';
import { ImageUploader } from './ImageUploader';
import { EvidenceView } from './EvidenceView';
import { DiagnosticsView } from './DiagnosticsView';
import { RawOutputView } from './RawOutputView';
import { ErrorOutcome, NotConfiguredGate } from './Common';
import { LIMITS, IDENTITY_CATEGORY_LABELS } from '../shared/constants';
import {
  assembleIdentityFeatures,
  confirmFeature,
  hardConstraints,
  rejectFeature,
} from '../shared/schema';
import type {
  IdentityFeature,
  ModelSettings,
  ProbeOutcome,
  UploadedImage,
} from '../shared/types';
import { buildIdentityMessages } from '../model/prompts';
import { runProbe } from '../model/arkClient';

type Props = {
  settings: ModelSettings | null;
  onOpenSettings: () => void;
};

export function IdentityProbePanel({ settings, onOpenSettings }: Props) {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [userStatement, setUserStatement] = useState('');
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<ProbeOutcome<IdentityFeature[]> | null>(null);
  const [features, setFeatures] = useState<IdentityFeature[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  async function run() {
    setFormError(null);
    if (images.length < LIMITS.identityImagesMin || images.length > LIMITS.identityImagesMax) {
      setFormError(`请上传同一商品 ${LIMITS.identityImagesMin}-${LIMITS.identityImagesMax} 张多角度照片`);
      return;
    }
    setLoading(true);
    setOutcome(null);
    const messages = buildIdentityMessages(images, userStatement);
    const result = await runProbe('identity', settings, messages, assembleIdentityFeatures);
    setOutcome(result);
    if (result.ok) setFeatures(result.data);
    setLoading(false);
  }

  if (!settings) {
    return (
      <div className="panel">
        <h2>B. 商品身份探针</h2>
        <p className="desc">上传同一商品 2-3 张多角度照片，输出形状/部件/颜色/材质/Logo/纹理候选特征。模型候选一律 pending，只有你确认后才成为硬约束。</p>
        <NotConfiguredGate onOpenSettings={onOpenSettings} />
      </div>
    );
  }

  const confirmed = hardConstraints(features);

  return (
    <div className="panel">
      <h2>B. 商品身份探针</h2>
      <p className="desc">
        模型提出的特征默认是 <b>pending（候选）</b>，不会自动当作事实；只有经你确认（confirmed）的特征才会成为商品硬约束。
      </p>

      <ImageUploader
        images={images}
        setImages={setImages}
        min={LIMITS.identityImagesMin}
        max={LIMITS.identityImagesMax}
        label="同一商品多角度照片"
      />
      <label className="field">
        <span>你的主动声明（可选，帮助核对，不会被模型覆盖）</span>
        <textarea
          value={userStatement}
          onChange={(e) => setUserStatement(e.target.value)}
          placeholder="例如：米白色陶瓷杯，杯身无 Logo，带木质杯盖"
        />
      </label>
      {formError && <p className="hint err">{formError}</p>}
      <button type="button" className="btn primary" onClick={run} disabled={loading}>
        {loading ? (
          <>
            <span className="spinner" /> 正在提取身份候选…
          </>
        ) : (
          '运行商品身份探针'
        )}
      </button>

      <div style={{ marginTop: 14 }}>
        {outcome && !outcome.ok && <ErrorOutcome error={outcome} raw={outcome.raw} />}
        {outcome && outcome.ok && (
          <div className="card" data-testid="identity-result">
            <div className="result-head">
              <strong>候选身份特征（{features.length} 项）</strong>
              <span className="badge confirmed">已确认硬约束 {confirmed.length}</span>
              <span className="badge pending">
                待确认 {features.filter((f) => f.status === 'pending').length}
              </span>
            </div>
            <table className="features">
              <thead>
                <tr>
                  <th>类别</th>
                  <th>特征描述</th>
                  <th>违反后果</th>
                  <th>状态</th>
                  <th>证据</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {features.map((f) => (
                  <tr key={f.id}>
                    <td>{IDENTITY_CATEGORY_LABELS[f.category] ?? f.category}</td>
                    <td>{f.statement}</td>
                    <td>
                      <span className={`badge ${f.severityIfViolated}`}>
                        {f.severityIfViolated}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${f.status}`} data-testid="feature-status">
                        {f.status === 'pending'
                          ? 'pending 候选'
                          : f.status === 'confirmed'
                            ? 'confirmed 硬约束'
                            : 'rejected 已否决'}
                      </span>
                      <div className="hint">{f.source}</div>
                    </td>
                    <td style={{ minWidth: 200 }}>
                      <EvidenceView evidence={f.evidence} />
                    </td>
                    <td>
                      {f.status !== 'confirmed' && (
                        <button
                          type="button"
                          className="btn sm primary"
                          onClick={() =>
                            setFeatures((fs) =>
                              fs.map((x) => (x.id === f.id ? confirmFeature(x) : x)),
                            )
                          }
                        >
                          确认
                        </button>
                      )}{' '}
                      {f.status !== 'rejected' && (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            setFeatures((fs) =>
                              fs.map((x) => (x.id === f.id ? rejectFeature(x) : x)),
                            )
                          }
                        >
                          否决
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="security-note">
              硬约束（仅来自人工确认）：
              {confirmed.length === 0
                ? ' 尚无；模型推测不会自动升级为事实。'
                : confirmed.map((f) => `【${f.statement}】`).join('、')}
            </div>
            <DiagnosticsView diagnostics={outcome.raw.diagnostics} />
            <RawOutputView raw={outcome.raw} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 节点检查器（覆盖抽屉，docs/12 §7）。
 * 数据驱动：按 NodeDefinition.configFields 的字段类型渲染表单；
 * 所有修改写入 node.config、进 undo 历史、触发保存、参与校验。
 * 不阻断画布上下文（无全屏遮罩，仅轻边界），点空白/Esc 关闭。
 */
import { useState } from 'react';
import { X, Copy, Trash2, Wand2, Loader2, Play } from 'lucide-react';
import { getNodeDefinition } from '../../workflow/graph/registry';
import { isSoloRunnableNode } from '../../workflow/graph/adapters';
import { LIMITS, RECIPE_FIELD_LABELS } from '../../shared/constants';
import { ImageListControl } from './ImageListControl';
import { ZoomableThumbs, readPreviewImages } from './ImageLightbox';
import { readRunLog, type RunIoItem } from '../../workflow/graph/runIo';
import {
  PORT_TYPE_LABELS,
  type GraphIssue,
  type NodeConfigField,
  type NodeInstance,
  type WorkflowGraph,
} from '../../workflow/graph/types';
import {
  canAutoFillPrompt,
  connectedProductSource,
  connectedPromptEditor,
  isVacantPrompt,
  promptEditorsFedBy,
  suggestedFromAnalyze,
  suggestedPromptPatch,
  visiblePrompt,
} from '../../workflow/graph/promptText';
import type { PromptOptimizationResult } from '../../workflow/promptOptimization';
import type { IdentityFeature, ModelSettings, VisualRecipe } from '../../shared/types';
import { isImageConfigured, isTextConfigured } from '../../shared/security';
import {
  ASPECT_RATIO_OPTIONS,
  fieldEnumLabel,
  normalizeGenerationResolution,
  RESOLUTION_OPTIONS,
  TARGET_USE_OPTIONS,
  type GenerationOption,
} from '../../workflow/generationOptions';

type OptimizeFn = (
  original: string,
  negative: string,
) => Promise<{ ok: true; data: PromptOptimizationResult } | { ok: false; message: string }>;

export function NodeInspector({
  node,
  graph,
  issues,
  onClose,
  onDelete,
  onDuplicate,
  onConfigChange,
  onConfigsChange,
  onSelectNode,
  onRequestOptimize,
  settings,
  onOpenSettings,
  onRunNode,
  running = false,
  runPreview = null,
}: {
  node: NodeInstance;
  graph: WorkflowGraph;
  issues: GraphIssue[];
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onConfigChange: (nodeId: string, key: string, value: unknown) => void;
  onConfigsChange?: (nodeId: string, patch: Record<string, unknown>) => void;
  onSelectNode?: (nodeId: string) => void;
  onRequestOptimize?: OptimizeFn;
  configured: boolean;
  settings: ModelSettings | null;
  onOpenSettings: () => void;
  onRunNode?: () => void;
  running?: boolean;
  runPreview?: {
    images?: { dataUri: string; mediaType: string }[];
    message: string;
    status: 'ok' | 'error';
    errorClass?: string;
  } | null;
}) {
  const def = getNodeDefinition(node.type);
  if (!def) return null;
  const incoming = graph.edges.filter((e) => e.to.node === node.id);
  const nodeIssues = issues.filter(
    (i) =>
      i.nodeId === node.id ||
      (i.edgeId && graph.edges.some((e) => e.id === i.edgeId && (e.from.node === node.id || e.to.node === node.id))),
  );

  const gateRecipe = recipeForGate(node, graph);
  const extractRecipe = isVisualRecipe(node.config.lastRecipe) ? node.config.lastRecipe : null;
  const displayRecipe =
    node.type === 'recipeConfirmGate' ? gateRecipe : extractRecipe;
  const displayIdentity =
    node.type === 'identityConfirmGate'
      ? identityForGate(node, graph)
      : isIdentityFeatureList(node.config.lastIdentityFeatures)
        ? node.config.lastIdentityFeatures
        : null;

  const soloRunnable = isSoloRunnableNode(node.type);
  const writeConfigs = (nodeId: string, patch: Record<string, unknown>) => {
    if (onConfigsChange) {
      onConfigsChange(nodeId, patch);
      return;
    }
    for (const [key, value] of Object.entries(patch)) onConfigChange(nodeId, key, value);
  };
  const promptSource = node.type === 'sceneGenerate' ? connectedPromptEditor(graph, node.id) : null;
  const productSource = node.type === 'sceneGenerate' ? connectedProductSource(graph, node.id) : null;
  const showOptimize =
    node.type === 'promptCompiler' || (node.type === 'sceneGenerate' && !promptSource);

  return (
    <aside className="inspector-overlay" role="dialog" aria-label={`${def.title} 节点检查器`} data-testid="node-inspector">
      <div className="inspector-head">
        <div>
          <h2>{def.title}</h2>
          <div className="hint" style={{ marginTop: 4 }}>
            {def.category}
            {def.isHumanGate && <span className="badge plain pending" style={{ marginLeft: 8 }}>人工确认</span>}
            {def.execution === 'planned' && (
              <span className="badge plain pending" style={{ marginLeft: 8 }}>规划中 · 暂不可执行</span>
            )}
          </div>
        </div>
        <div className="inspector-head-actions">
          {soloRunnable && onRunNode && (
            <button
              type="button"
              className="btn primary"
              onClick={onRunNode}
              disabled={running}
              data-testid="inspector-run-node"
              title={
                node.type === 'sceneGenerate'
                  ? '只用此节点当前配置出图'
                  : node.type === 'promptEditor'
                    ? '预览将送给生成节点的提示词'
                    : '只运行此节点'
              }
            >
              {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
              {running ? '运行中…' : '试运行'}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="关闭检查器（Esc）" onClick={onClose} data-testid="inspector-close">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="inspector-body">
        <p className="hint node-summary">{def.summary}</p>

        {/* 端口 */}
        {def.inputs.length > 0 && (
          <section>
            <h4 className="insp-section-title">输入</h4>
            {def.inputs.map((p) => {
              const connected = incoming.find((e) => e.to.port === p.portId);
              return (
                <div className={`port-row ${connected ? '' : 'unconnected'}`} key={p.portId}>
                  <span className="port-type-dot" data-type={p.dataType} />
                  <span className="port-label">{p.label}{p.required && <em className="req">*</em>}</span>
                  <span className="port-type">{PORT_TYPE_LABELS[p.dataType]}</span>
                  <span className={`badge plain ${connected ? 'confirmed' : 'rejected'}`}>
                    {connected ? '已连接' : '未连接'}
                  </span>
                </div>
              );
            })}
          </section>
        )}
        {def.outputs.length > 0 && (
          <section>
            <h4 className="insp-section-title">输出</h4>
            {def.outputs.map((p) => (
              <div className="port-row" key={`o-${p.portId}`}>
                <span className="port-type-dot" data-type={p.dataType} />
                <span className="port-label">{p.label}</span>
                <span className="port-type">{PORT_TYPE_LABELS[p.dataType]}</span>
              </div>
            ))}
          </section>
        )}

        {/* 数据驱动配置表单 */}
        {def.configFields.length > 0 && (
          <section>
            <h4 className="insp-section-title">配置</h4>
            {node.type === 'referenceAnalyze' ? (
              <AnalysisConfigPanel
                node={node}
                graph={graph}
                onChange={(key, value) => onConfigChange(node.id, key, value)}
                onConfigsChange={writeConfigs}
              />
            ) : node.type === 'promptEditor' ? (
              <PromptEditorPanel
                node={node}
                graph={graph}
                settings={settings}
                onOpenSettings={onOpenSettings}
                onRequestOptimize={onRequestOptimize}
                onConfigsChange={writeConfigs}
              />
            ) : node.type === 'sceneGenerate' ? (
              <GenerationConfigPanel
                node={node}
                settings={settings}
                onOpenSettings={onOpenSettings}
                onChange={(key, value) => onConfigChange(node.id, key, value)}
                promptSource={promptSource}
                productSource={productSource}
                onSelectNode={onSelectNode}
              />
            ) : (
              def.configFields
                .filter((field) => field.key !== 'lastRecipe' && field.key !== 'confirmedRecipe')
                .map((field) => (
                  <ConfigFieldEditor
                    key={field.key}
                    field={field}
                    value={node.config[field.key]}
                    planned={def.execution === 'planned'}
                    onChange={(v) => onConfigChange(node.id, field.key, v)}
                  />
                ))
            )}

            {(node.type === 'recipeConfirmGate' || node.type === 'recipeExtractor') && displayRecipe && (
              <RecipeResultPanel
                recipe={displayRecipe}
                meta={
                  node.type === 'recipeConfirmGate'
                    ? upstreamAnalysisMeta(node, graph)
                    : node.config.analysisMeta
                }
                onConfirm={() => {
                  const next = {
                    ...displayRecipe,
                    confirmedAt: new Date().toISOString(),
                  };
                  if (node.type === 'recipeConfirmGate') {
                    onConfigChange(node.id, 'confirmedRecipe', next);
                  } else {
                    onConfigChange(node.id, 'lastRecipe', next);
                  }
                }}
                onUnconfirm={() => {
                  if (node.type === 'recipeConfirmGate') {
                    onConfigChange(node.id, 'confirmedRecipe', {
                      ...displayRecipe,
                      confirmedAt: undefined,
                    });
                  } else {
                    onConfigChange(node.id, 'lastRecipe', {
                      ...displayRecipe,
                      confirmedAt: undefined,
                    });
                  }
                }}
              />
            )}

            {displayIdentity && (
              <IdentityResultPanel
                features={displayIdentity}
                onConfirm={() => {
                  const confirmed = displayIdentity.map((feature) => ({
                    ...feature,
                    status:
                      feature.status === 'rejected'
                        ? 'rejected' as const
                        : 'confirmed' as const,
                  }));
                  if (node.type === 'identityConfirmGate') {
                    onConfigChange(node.id, 'confirmedFeatures', confirmed);
                  } else {
                    onConfigChange(node.id, 'lastIdentityFeatures', confirmed);
                  }
                }}
                onUnconfirm={() => {
                  const pending = displayIdentity.map((feature) => ({
                    ...feature,
                    status:
                      feature.status === 'rejected'
                        ? 'rejected' as const
                        : 'pending' as const,
                  }));
                  if (node.type === 'identityConfirmGate') {
                    onConfigChange(node.id, 'confirmedFeatures', pending);
                  } else {
                    onConfigChange(node.id, 'lastIdentityFeatures', pending);
                  }
                }}
              />
            )}

            {showOptimize && (
              <PromptOptimizeBlock
                node={node}
                settings={settings}
                onOpenSettings={onOpenSettings}
                onRequest={onRequestOptimize}
                onApply={(text) =>
                  writeConfigs(node.id, { positivePrompt: text, promptEditedByUser: true })
                }
              />
            )}
          </section>
        )}

        {/* 单节点 / 整图试运行日志（扣子式输入输出） */}
        {(runPreview || readRunLog(node.config.lastRunIo) || readPreviewImages(node.config.lastOutputImages).length > 0) && (
          <section data-testid="inspector-run-preview">
            <h4 className="insp-section-title">试运行日志</h4>
            {runPreview && (
              <div className={`issue-banner ${runPreview.status === 'ok' ? 'hint' : 'error'}`}>
                <strong>{runPreview.status === 'ok' ? '完成' : '失败'}</strong>
                <span>{runPreview.message}</span>
              </div>
            )}
            {(runPreview?.errorClass === 'invalid-key' || runPreview?.errorClass === 'not-configured') && (
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button type="button" className="btn sm" onClick={onOpenSettings} data-testid="inspector-run-open-settings">
                  去更换 Key
                </button>
              </div>
            )}
            <RunIoBlock node={node} fallbackImages={runPreview?.images} />
          </section>
        )}

        {/* 校验问题：只在有问题时展示 */}
        {nodeIssues.length > 0 && (
          <section>
            <h4 className="insp-section-title">校验问题</h4>
            {nodeIssues.map((iss, i) => (
              <div key={i} className={`issue-banner ${iss.level}`}>
                <strong>{iss.level === 'error' ? '错误' : iss.level === 'warning' ? '警告' : '提示'}</strong>
                <span>{iss.message}</span>
                <code className="run-no">{iss.code}</code>
              </div>
            ))}
          </section>
        )}
      </div>

      <div className="inspector-foot">
        <button type="button" className="btn" onClick={onDuplicate} data-testid="inspector-duplicate">
          <Copy size={14} /> 复制节点
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={onDelete}
          disabled={!def.removable}
          title={def.removable ? '删除节点及其连线' : '该节点是必需节点，不能删除'}
          data-testid="inspector-delete"
        >
          <Trash2 size={14} /> 删除
        </button>
      </div>
    </aside>
  );
}

function RunIoBlock({
  node,
  fallbackImages,
}: {
  node: NodeInstance;
  fallbackImages?: { dataUri: string; mediaType: string }[];
}) {
  const log = readRunLog(node.config.lastRunIo);
  const outputImages = log?.outputs.find((item) => item.kind === 'image')?.images
    ?? (fallbackImages?.length ? fallbackImages : readPreviewImages(node.config.lastOutputImages));
  if (!log && !outputImages.length) return null;
  const stale = promptLogIsStale(node);
  return (
    <div className="run-io" data-testid="inspector-run-io">
      {log && (
        <p className="run-io-meta">
          {log.scope === 'workflow' ? '整图运行' : '单节点试运行'}
          {log.durationMs > 0 ? ` · ${(log.durationMs / 1000).toFixed(1)}s` : ''}
        </p>
      )}
      {stale ? (
        <p className="hint" data-testid="stale-prompt-log">
          上次预览时提示词还是空的，当前正文以上方输入框为准。
        </p>
      ) : (
        <>
          {log?.inputs.map((item) => (
            <RunIoItemView key={`in-${item.key}`} title={`输入 · ${item.label}`} item={item} />
          ))}
          {log?.outputs.map((item) => (
            <RunIoItemView key={`out-${item.key}`} title={`输出 · ${item.label}`} item={item} />
          ))}
        </>
      )}
      {!log && outputImages.length > 0 && (
        <div className="run-io-item">
          <span>输出 · 生成图</span>
          <ZoomableThumbs images={outputImages} className="thumbs inspector-run-thumbs" altPrefix="生成结果" />
        </div>
      )}
    </div>
  );
}

function readableRunText(text: string | undefined): string {
  return visiblePrompt(text) || '（空）';
}

function promptLogIsStale(node: NodeInstance): boolean {
  if (node.type !== 'promptEditor' && node.type !== 'promptCompiler') return false;
  const log = readRunLog(node.config.lastRunIo);
  if (!log) return false;
  const texts = [...log.inputs, ...log.outputs].filter((item) => item.kind === 'text');
  return texts.length > 0 && texts.every((item) => !visiblePrompt(item.text));
}

function RunIoItemView({ title, item }: { title: string; item: RunIoItem }) {
  return (
    <div className="run-io-item">
      <span>{title}</span>
      {item.kind === 'image' && item.images && item.images.length > 0 ? (
        <ZoomableThumbs images={item.images} className="thumbs inspector-run-thumbs" altPrefix={item.label} />
      ) : (
        <p>{readableRunText(item.text)}</p>
      )}
    </div>
  );
}

function AnalysisConfigPanel({
  node,
  graph,
  onChange,
  onConfigsChange,
}: {
  node: NodeInstance;
  graph: WorkflowGraph;
  onChange: (key: string, value: unknown) => void;
  onConfigsChange: (nodeId: string, patch: Record<string, unknown>) => void;
}) {
  const [overwrite, setOverwrite] = useState(false);
  const suggested = suggestedFromAnalyze(node);
  const editors = promptEditorsFedBy(graph, node.id);
  const recipe = isVisualRecipe(node.config.lastRecipe) ? node.config.lastRecipe : null;
  const meta =
    node.config.analysisMeta && typeof node.config.analysisMeta === 'object'
      ? (node.config.analysisMeta as {
          imageRoles?: Array<{ role: string; note?: string }>;
          conflictHint?: string;
        })
      : null;

  function apply(force: boolean) {
    if (!suggested.trim() || !editors.length) return;
    const blocked = editors.some(
      (editor) => !canAutoFillPrompt(editor.config) && !isVacantPrompt(editor.config.positivePrompt),
    );
    if (blocked && !force) {
      setOverwrite(true);
      return;
    }
    for (const editor of editors) {
      onConfigsChange(editor.id, suggestedPromptPatch(suggested));
    }
    setOverwrite(false);
  }

  return (
    <div className="generation-config" data-testid="analysis-config">
      <div className="generation-config-section">
        <div className="generation-config-title">
          <strong>参考图</strong>
          <span>1–5 张；只用于分析画面，不会作为生成参考图发送</span>
        </div>
        <ImageListControl
          value={node.config.images}
          max={LIMITS.referenceImagesMax}
          addLabel="上传参考图"
          onChange={(images) => onChange('images', images)}
        />
      </div>

      <label className="field">
        <span>场景用途</span>
        <LabeledSelect
          value={String(node.config.purpose ?? 'main-scene')}
          options={TARGET_USE_OPTIONS}
          onChange={(value) => onChange('purpose', value)}
          testId="cfg-purpose"
        />
      </label>

      <label className="field field-switch">
        <input
          type="checkbox"
          checked={node.config.excludeSubject !== false}
          onChange={(event) => onChange('excludeSubject', event.target.checked)}
          data-testid="cfg-excludeSubject"
        />
        <span>排除参考图中的商品主体</span>
      </label>

      {(suggested || meta?.conflictHint || recipe) && (
        <div className="generation-config-section" data-testid="analysis-result">
          <div className="generation-config-title">
            <strong>运行结果</strong>
            <span>建议提示词可复制或采用到提示词节点</span>
          </div>
          {meta?.conflictHint && (
            <div className="issue-banner warning" data-testid="analysis-conflict-hint">
              <strong>冲突提示</strong>
              <span>{meta.conflictHint}</span>
            </div>
          )}
          {meta?.imageRoles && meta.imageRoles.length > 0 && (
            <p className="hint" data-testid="analysis-image-roles">
              图型判断：
              {meta.imageRoles.map((role) => `${role.role}${role.note ? `(${role.note})` : ''}`).join(' · ')}
            </p>
          )}
          {suggested ? (
            <pre className="prompt-readonly-box" data-testid="suggested-prompt">{suggested}</pre>
          ) : (
            <p className="hint">试运行后，这里会给出建议提示词。</p>
          )}
          <div className="btn-row" style={{ marginTop: 8 }}>
            {suggested && (
              <button
                type="button"
                className="btn sm"
                onClick={() => { void navigator.clipboard?.writeText(suggested); }}
              >
                <Copy size={13} /> 复制建议
              </button>
            )}
            {editors.length > 0 ? (
              <button
                type="button"
                className="btn primary sm"
                onClick={() => apply(false)}
                disabled={!suggested}
                data-testid="apply-suggested-prompt"
              >
                采用到提示词节点
              </button>
            ) : (
              <p className="hint">没有连接提示词节点。可复制建议，或连到「提示词编辑与优化」后再采用。</p>
            )}
          </div>
          {overwrite && (
            <div className="issue-banner warning" style={{ marginTop: 8 }} data-testid="apply-overwrite-confirm">
              <strong>提示词已手改</strong>
              <span>采用将覆盖现有正文。</span>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button type="button" className="btn sm" onClick={() => setOverwrite(false)}>取消</button>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => apply(true)}
                  data-testid="apply-suggested-overwrite"
                >
                  覆盖并采用
                </button>
              </div>
            </div>
          )}
          {recipe && (
            <details className="analysis-evidence">
              <summary>结构要点</summary>
              <RecipeResultPanel recipe={recipe} meta={node.config.analysisMeta} confirmable={false} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function PromptEditorPanel({
  node,
  graph,
  settings,
  onOpenSettings,
  onRequestOptimize,
  onConfigsChange,
}: {
  node: NodeInstance;
  graph: WorkflowGraph;
  settings: ModelSettings | null;
  onOpenSettings: () => void;
  onRequestOptimize?: OptimizeFn;
  onConfigsChange: (nodeId: string, patch: Record<string, unknown>) => void;
}) {
  const [overwrite, setOverwrite] = useState(false);
  const recipeEdge = graph.edges.find((edge) => edge.to.node === node.id && edge.to.port === 'recipe');
  const analyze = recipeEdge
    ? graph.nodes.find((item) => item.id === recipeEdge.from.node) ?? null
    : graph.nodes.find((item) => item.type === 'referenceAnalyze') ?? null;
  const suggested = suggestedFromAnalyze(analyze);
  const current = visiblePrompt(node.config.positivePrompt);
  const same = !!suggested.trim() && current === suggested.trim();

  function applyFromAnalysis(force: boolean) {
    if (!suggested.trim()) return;
    if (!force && current && !same) {
      setOverwrite(true);
      return;
    }
    onConfigsChange(node.id, suggestedPromptPatch(suggested));
    setOverwrite(false);
  }

  const adopt = !suggested.trim() ? (
    <span className="prompt-composer-note">先运行「参考图分析」，才能把建议填到这里</span>
  ) : same ? (
    <span className="prompt-composer-note">已与参考图分析一致</span>
  ) : (
    <button
      type="button"
      className="prompt-composer-link"
      onClick={() => applyFromAnalysis(false)}
      data-testid="apply-from-analysis"
    >
      {current ? '用分析建议替换' : '填入分析建议'}
    </button>
  );

  return (
    <div className="generation-config" data-testid="prompt-editor-panel">
      <div className="prompt-composer-box">
        <textarea
          rows={8}
          value={current}
          placeholder="描述希望生成的画面，例如：浅色石材台面上的护肤品，柔和侧光，主体完整清晰"
          onChange={(event) =>
            onConfigsChange(node.id, {
              positivePrompt: event.target.value,
              promptEditedByUser: true,
            })
          }
          data-testid="cfg-prompt-editor"
        />
        <div className="prompt-composer-adopt">{adopt}</div>
        <PromptOptimizeBlock
          inline
          node={node}
          settings={settings}
          onOpenSettings={onOpenSettings}
          onRequest={onRequestOptimize}
          onApply={(text) =>
            onConfigsChange(node.id, { positivePrompt: text, promptEditedByUser: true })
          }
        />
      </div>
      {overwrite && (
        <div className="issue-banner warning" data-testid="prompt-overwrite-confirm">
          <strong>将替换当前提示词</strong>
          <span>参考图分析的建议会覆盖你正在编辑的正文。</span>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button type="button" className="btn sm" onClick={() => setOverwrite(false)}>取消</button>
            <button
              type="button"
              className="btn primary sm"
              onClick={() => applyFromAnalysis(true)}
              data-testid="apply-from-analysis-overwrite"
            >
              替换
            </button>
          </div>
        </div>
      )}

      <details className="generation-advanced">
        <summary>高级设置</summary>
        <label className="field">
          <span>负面提示词</span>
          <textarea
            rows={3}
            value={String(node.config.negativePrompt ?? '')}
            placeholder="例如：避免文字乱码、主体变形、额外商品"
            onChange={(event) => onConfigsChange(node.id, { negativePrompt: event.target.value })}
            data-testid="cfg-prompt-negative"
          />
        </label>
      </details>
    </div>
  );
}

function GenerationConfigPanel({
  node,
  settings,
  onOpenSettings,
  onChange,
  promptSource,
  productSource,
  onSelectNode,
}: {
  node: NodeInstance;
  settings: ModelSettings | null;
  onOpenSettings: () => void;
  onChange: (key: string, value: unknown) => void;
  promptSource?: NodeInstance | null;
  productSource?: NodeInstance | null;
  onSelectNode?: (nodeId: string) => void;
}) {
  const count = Math.min(4, Math.max(1, Number(node.config.count) || 1));
  const sourcePrompt = visiblePrompt(promptSource?.config.positivePrompt);
  const productTitle = productSource ? getNodeDefinition(productSource.type)?.title ?? '上游' : '';
  const productThumbs = productSource
    ? readPreviewImages(
        readPreviewImages(productSource.config.images).length
          ? productSource.config.images
          : productSource.config.productImages,
      )
    : [];
  return (
    <div className="generation-config" data-testid="generation-config">
      {productSource ? (
        <div className="generation-config-section" data-testid="generation-products-readonly">
          <div className="generation-config-title">
            <strong>商品图片</strong>
            <span>来自：{productTitle}</span>
          </div>
          {productThumbs.length ? (
            <ZoomableThumbs images={productThumbs} altPrefix="商品图" />
          ) : (
            <p className="hint">上游尚未上传商品图。</p>
          )}
          <em className="generation-prompt-hint">生成节点不再平行上传商品图。改图请到上游节点。</em>
          {onSelectNode && (
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn sm"
                onClick={() => onSelectNode(productSource.id)}
                data-testid="jump-to-product-source"
              >
                打开商品图节点
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="generation-config-section">
          <div className="generation-config-title">
            <strong>商品图片</strong>
            <span>1–10 张；会作为生成参考图发送给图片模型</span>
          </div>
          <ImageListControl
            value={node.config.productImages}
            max={10}
            addLabel="上传商品图"
            onChange={(images) => onChange('productImages', images)}
          />
        </div>
      )}

      {promptSource ? (
        <div className="generation-config-section" data-testid="generation-prompt-readonly">
          <div className="generation-config-title">
            <strong>提示词</strong>
            <span>来自：提示词编辑与优化</span>
          </div>
          <pre className="prompt-readonly-box">{sourcePrompt || '（提示词节点尚未填写）'}</pre>
          <em className="generation-prompt-hint">生成节点不再平行编辑这份正文。改提示词请到上游节点。</em>
          {onSelectNode && (
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn sm"
                onClick={() => onSelectNode(promptSource.id)}
                data-testid="jump-to-prompt-editor"
              >
                打开提示词节点
              </button>
            </div>
          )}
        </div>
      ) : (
        <label className="field generation-prompt">
          <span>提示词</span>
          <textarea
            rows={6}
            value={visiblePrompt(node.config.positivePrompt)}
            placeholder="描述希望生成的商品图片，例如：将护肤品放在浅色石材台面上，柔和侧光，主体完整清晰"
            onChange={(event) => onChange('positivePrompt', event.target.value)}
            data-testid="cfg-generation-prompt"
          />
          <em>直接描述画面即可；商品图会单独作为参考输入，不需要插入变量。</em>
        </label>
      )}

      <label className="field">
        <span>输出用途</span>
        <LabeledSelect
          value={String(node.config.targetUse ?? 'main-scene')}
          options={TARGET_USE_OPTIONS}
          onChange={(value) => onChange('targetUse', value)}
          testId="cfg-targetUse"
        />
      </label>

      <div className="generation-config-section">
        <div className="generation-config-title">
          <strong>画面比例</strong>
          <span>选择最终图片的构图方向</span>
        </div>
        <OptionGrid
          value={String(node.config.aspectRatio ?? '1:1')}
          options={ASPECT_RATIO_OPTIONS}
          onChange={(value) => onChange('aspectRatio', value)}
          testId="cfg-aspectRatio"
        />
      </div>

      <div className="generation-config-section">
        <div className="generation-config-title">
          <strong>分辨率</strong>
          <span>高清输出耗时与成本更高</span>
        </div>
        <OptionGrid
          value={normalizeGenerationResolution(node.config.resolution)}
          options={RESOLUTION_OPTIONS}
          onChange={(value) => onChange('resolution', value)}
          testId="cfg-resolution"
        />
      </div>

      <div className="generation-config-section">
        <div className="generation-config-title">
          <strong>生成数量</strong>
          <span>每次最多 4 张</span>
        </div>
        <div className="count-stepper">
          <button
            type="button"
            aria-label="减少生成数量"
            disabled={count <= 1}
            onClick={() => onChange('count', count - 1)}
          >
            −
          </button>
          <input
            type="number"
            min={1}
            max={4}
            value={count}
            onChange={(event) =>
              onChange(
                'count',
                Math.min(4, Math.max(1, Number(event.target.value) || 1)),
              )
            }
            data-testid="cfg-count"
          />
          <button
            type="button"
            aria-label="增加生成数量"
            disabled={count >= 4}
            onClick={() => onChange('count', count + 1)}
          >
            +
          </button>
        </div>
      </div>

      <div className="generation-model">
        <div>
          <strong>图片模型</strong>
          <span>{settings?.imageEndpoint || '尚未配置 Seedream 5.0'}</span>
        </div>
        {isImageConfigured(settings) ? (
          <span className="badge plain confirmed">使用项目设置</span>
        ) : (
          <button type="button" className="btn sm" onClick={onOpenSettings}>
            去配置
          </button>
        )}
      </div>

      <details className="generation-advanced">
        <summary>高级设置</summary>
        <label className="field">
          <span>负面提示词</span>
          <textarea
            rows={3}
            value={String(node.config.negativePrompt ?? '')}
            placeholder="例如：避免文字乱码、主体变形、额外商品"
            onChange={(event) => onChange('negativePrompt', event.target.value)}
            data-testid="cfg-negativePrompt"
          />
        </label>
      </details>
    </div>
  );
}

function LabeledSelect({
  value,
  options,
  onChange,
  testId,
}: {
  value: string;
  options: GenerationOption[];
  onChange: (value: string) => void;
  testId: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      data-testid={testId}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function OptionGrid({
  value,
  options,
  onChange,
  testId,
}: {
  value: string;
  options: GenerationOption[];
  onChange: (value: string) => void;
  testId: string;
}) {
  return (
    <div className="generation-option-grid" data-testid={testId}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? 'active' : ''}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ConfigFieldEditor({
  field,
  value,
  onChange,
  planned = false,
}: {
  field: NodeConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
  planned?: boolean;
}) {
  const v = value ?? field.defaultValue;
  const labelEl = (
    <span>
      {field.label}
      {field.help && <em className="field-help">{field.help}</em>}
    </span>
  );

  switch (field.dataType) {
    case 'switch':
      return (
        <label className="field field-switch" key={field.key}>
          <input type="checkbox" checked={!!v} onChange={(e) => onChange(e.target.checked)} data-testid={`cfg-${field.key}`} />
          {labelEl}
        </label>
      );
    case 'slider':
      return (
        <label className="field" key={field.key}>
          {labelEl}
          <div className="slider-row">
            <input
              type="range"
              min={field.min ?? 0}
              max={field.max ?? 1}
              step={field.step ?? 0.05}
              value={Number(v) ?? 0}
              onChange={(e) => onChange(Number(e.target.value))}
              data-testid={`cfg-${field.key}`}
            />
            <span className="slider-val">{Math.round((Number(v) ?? 0) * 100)}%</span>
          </div>
        </label>
      );
    case 'number':
      return (
        <label className="field" key={field.key}>
          {labelEl}
          <input
            type="number"
            value={v === '' ? '' : Number(v)}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            data-testid={`cfg-${field.key}`}
          />
        </label>
      );
    case 'select':
    case 'aspect-ratio':
    case 'resolution':
    case 'model-selector':
      return (
        <label className="field" key={field.key}>
          {labelEl}
          <select value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={`cfg-${field.key}`}>
            {(field.enumValues ?? ['default']).map((opt) => (
              <option key={opt} value={opt}>
                {fieldEnumLabel(field, opt)}
              </option>
            ))}
          </select>
        </label>
      );
    case 'textarea':
      return (
        <label className="field" key={field.key}>
          {labelEl}
          <textarea rows={3} value={String(v ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} data-testid={`cfg-${field.key}`} />
        </label>
      );
    case 'prompt-editor':
      return <PromptEditor key={field.key} field={field} value={String(v ?? '')} onChange={onChange} />;
    case 'readonly-output':
      return (
        <div className="field" key={field.key}>
          {labelEl}
          <pre className="readonly-box">{String(v ?? '') || '（运行后显示）'}</pre>
        </div>
      );
    case 'image-list':
    case 'image-upload': {
      const isProduct = field.key === 'productImages' || field.label.includes('商品');
      return (
        <div className="field" key={field.key}>
          {labelEl}
          <ImageListControl
            value={v}
            max={typeof field.max === 'number' ? field.max : isProduct ? LIMITS.identityImagesMax : LIMITS.referenceImagesMax}
            addLabel={isProduct ? '上传商品图' : '上传参考图'}
            onChange={onChange}
            disabled={planned}
            disabledReason={planned ? '规划中节点暂不可执行，上传不会进入试运行' : undefined}
          />
          {isProduct && <p className="hint">商品图会随工作流作为生成参考输入。</p>}
        </div>
      );
    }
    case 'text':
    default:
      return (
        <label className="field" key={field.key}>
          {labelEl}
          <input type="text" value={String(v ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} data-testid={`cfg-${field.key}`} />
        </label>
      );
  }
}

function PromptEditor({ field, value, onChange }: { field: NodeConfigField; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const insertVar = (varName: string) => setText((t) => `${t}${t && !t.endsWith('\n') ? '\n' : ''}${varName}`);
  return (
    <div className="field prompt-field" key={field.key}>
      <span>{field.label}</span>
      <div className="prompt-vars">
        {(field.variables ?? []).map((v) => (
          <button type="button" key={v} className="var-chip" onClick={() => insertVar(v)} title={`插入变量 ${v}`}>
            {v}
          </button>
        ))}
      </div>
      <textarea
        className="prompt-textarea"
        rows={7}
        value={text}
        placeholder="可编辑创意描述；已确认的商品身份与配方事实为只读约束，不会被覆盖。"
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        data-testid="cfg-positivePrompt"
      />
      <div className="prompt-zones hint">
        上游事实（只读） · 创意描述（可编辑） · 负面提示词（下方独立字段）
      </div>
    </div>
  );
}

/**
 * 优化提示词区块：调用文本模型给出建议，必须由用户确认才写回。
 * 失败保留原文；不自动覆盖；提示是否影响身份/引入未确认事实。
 */
function PromptOptimizeBlock({
  node,
  settings,
  onOpenSettings,
  onRequest,
  onApply,
  inline = false,
}: {
  node: NodeInstance;
  settings: ModelSettings | null;
  onOpenSettings: () => void;
  onRequest?: OptimizeFn;
  onApply: (text: string) => void;
  inline?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<PromptOptimizationResult | null>(null);
  const [error, setError] = useState('');
  const original = visiblePrompt(node.config.positivePrompt);
  const negative = String(node.config.negativePrompt ?? '');
  const textReady = isTextConfigured(settings);

  async function run() {
    if (!textReady) {
      onOpenSettings();
      return;
    }
    if (!original.trim()) {
      setError('请先在主提示词中填写内容，再进行优化');
      setState('error');
      return;
    }
    setState('loading');
    setError('');
    const r = await onRequest?.(original, negative);
    if (r && r.ok) {
      setResult(r.data);
      setState('done');
    } else {
      setError(r?.message ?? '优化请求失败，已保留原提示词');
      setState('error');
    }
  }

  const feedback = (
    <>
      {state === 'error' && <div className="issue-banner error">{error}</div>}
      {state === 'done' && result && (
        <div className="optimize-result" data-testid="optimize-result">
          {(result.affectsIdentity || result.introducesFacts) && (
            <div className="issue-banner warning">
              {result.affectsIdentity && '该建议可能影响商品身份约束；'}
              {result.introducesFacts && '疑似引入了未确认的商品事实，请仔细核对。'}
            </div>
          )}
          {result.changes.length > 0 && (
            <ul className="optimize-changes">
              {result.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          <pre className="readonly-box optimize-text">{result.optimizedPrompt}</pre>
          <div className="optimize-actions">
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setState('idle');
                setResult(null);
              }}
            >
              放弃
            </button>
            <button type="button" className="btn" onClick={() => { void navigator.clipboard?.writeText(result.optimizedPrompt); }}>
              <Copy size={13} /> 仅复制
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onApply(result.optimizedPrompt);
                setState('idle');
                setResult(null);
              }}
              data-testid="apply-optimization"
            >
              应用优化
            </button>
          </div>
        </div>
      )}
    </>
  );

  if (inline) {
    return (
      <div className="prompt-optimize-inline" data-testid="optimize-block">
        <button
          type="button"
          className="prompt-composer-action"
          onClick={run}
          disabled={state === 'loading'}
          data-testid="optimize-prompt"
          title={textReady ? '让文本模型改写当前提示词，确认后才写回' : '需要先配置文本模型'}
        >
          {state === 'loading' ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
          {state === 'loading' ? '优化中…' : '优化'}
        </button>
        {(state === 'error' || state === 'done') && (
          <div className="prompt-optimize-extra">{feedback}</div>
        )}
      </div>
    );
  }

  return (
    <div className="prompt-optimize-block" data-testid="optimize-block">
      <button type="button" className="btn" onClick={run} disabled={state === 'loading'} data-testid="optimize-prompt">
        {state === 'loading' ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
        优化提示词
      </button>
      {!textReady && <span className="hint">需要先配置文本模型，点击打开模型设置</span>}
      {feedback}
    </div>
  );
}

function isVisualRecipe(v: unknown): v is VisualRecipe {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as VisualRecipe).fields) &&
    typeof (v as VisualRecipe).name === 'string'
  );
}

function recipeForGate(
  node: NodeInstance,
  graph: { nodes: NodeInstance[]; edges: { from: { node: string }; to: { node: string; port: string } }[] },
): VisualRecipe | null {
  if (isVisualRecipe(node.config.confirmedRecipe)) return node.config.confirmedRecipe;
  const edge = graph.edges.find((e) => e.to.node === node.id && e.to.port === 'recipe');
  if (!edge) return null;
  const upstream = graph.nodes.find((n) => n.id === edge.from.node);
  if (!upstream) return null;
  return isVisualRecipe(upstream.config.lastRecipe) ? upstream.config.lastRecipe : null;
}

function upstreamAnalysisMeta(
  node: NodeInstance,
  graph: { nodes: NodeInstance[]; edges: { from: { node: string }; to: { node: string; port: string } }[] },
): unknown {
  const edge = graph.edges.find((e) => e.to.node === node.id && e.to.port === 'recipe');
  if (!edge) return undefined;
  const upstream = graph.nodes.find((n) => n.id === edge.from.node);
  return upstream?.config.analysisMeta;
}

function isIdentityFeatureList(value: unknown): value is IdentityFeature[] {
  return (
    Array.isArray(value) &&
    value.every(
      (feature) =>
        !!feature &&
        typeof feature === 'object' &&
        typeof (feature as IdentityFeature).id === 'string' &&
        typeof (feature as IdentityFeature).statement === 'string',
    )
  );
}

function identityForGate(
  node: NodeInstance,
  graph: { nodes: NodeInstance[]; edges: { from: { node: string }; to: { node: string; port: string } }[] },
): IdentityFeature[] | null {
  if (isIdentityFeatureList(node.config.confirmedFeatures)) return node.config.confirmedFeatures;
  const edge = graph.edges.find((item) => item.to.node === node.id && item.to.port === 'features');
  if (!edge) return null;
  const upstream = graph.nodes.find((item) => item.id === edge.from.node);
  return upstream && isIdentityFeatureList(upstream.config.lastIdentityFeatures)
    ? upstream.config.lastIdentityFeatures
    : null;
}

function IdentityResultPanel({
  features,
  onConfirm,
  onUnconfirm,
}: {
  features: IdentityFeature[];
  onConfirm: () => void;
  onUnconfirm: () => void;
}) {
  const confirmed = features.some((feature) => feature.status === 'confirmed');
  return (
    <div className="field recipe-result" data-testid="inspector-identity-result">
      <span className="insp-section-title" style={{ display: 'block', marginBottom: 8 }}>
        商品身份 · {confirmed ? '已确认' : '待确认'}
      </span>
      <div className="kv-list recipe-fields">
        {features.map((feature) => (
          <div key={feature.id} className="recipe-field-row">
            <span className="k">{feature.category}</span>
            <span>{feature.statement}</span>
          </div>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        {!confirmed ? (
          <button type="button" className="btn primary" onClick={onConfirm} data-testid="confirm-identity">
            确认身份硬约束
          </button>
        ) : (
          <button type="button" className="btn" onClick={onUnconfirm} data-testid="unconfirm-identity">
            撤销确认
          </button>
        )}
      </div>
    </div>
  );
}

function RecipeResultPanel({
  recipe,
  meta,
  onConfirm,
  onUnconfirm,
  confirmable = true,
}: {
  recipe: VisualRecipe;
  meta?: unknown;
  onConfirm?: () => void;
  onUnconfirm?: () => void;
  confirmable?: boolean;
}) {
  const analysisMeta =
    meta && typeof meta === 'object' && Array.isArray((meta as { imageRoles?: unknown }).imageRoles)
      ? (meta as {
          imageRoles: Array<{ sourceId: string; role: string; note?: string }>;
          conflictHint?: string;
          purposeBucket?: string;
        })
      : null;
  const confirmed = !!recipe.confirmedAt;

  return (
    <div className="field recipe-result" data-testid="inspector-recipe-result">
      <span className="insp-section-title" style={{ display: 'block', marginBottom: 8 }}>
        {confirmable
          ? `视觉配方 · ${recipe.name}${confirmed ? ' · 已确认' : ' · 待确认'}`
          : recipe.name}
      </span>

      {analysisMeta?.conflictHint && (
        <div className="issue-banner warning" data-testid="analysis-conflict-hint" style={{ marginBottom: 10 }}>
          <strong>冲突提示</strong>
          <span>{analysisMeta.conflictHint}</span>
        </div>
      )}

      {analysisMeta && analysisMeta.imageRoles.length > 0 && (
        <div className="hint" style={{ marginBottom: 10 }} data-testid="analysis-image-roles">
          图型判断：
          {analysisMeta.imageRoles
            .map((r) => `${r.role}${r.note ? `(${r.note})` : ''}`)
            .join(' · ')}
        </div>
      )}

      {confirmable && (
      <div className="btn-row" style={{ marginBottom: 12 }}>
        {!confirmed ? (
          <button type="button" className="btn primary" onClick={onConfirm} data-testid="confirm-recipe">
            确认配方（可供下游使用）
          </button>
        ) : (
          <button type="button" className="btn" onClick={onUnconfirm} data-testid="unconfirm-recipe">
            撤销确认
          </button>
        )}
      </div>
      )}

      <div className="kv-list recipe-fields">
        {recipe.fields.map((f) => (
          <div key={f.key} className="recipe-field-row">
            <span className="k">{RECIPE_FIELD_LABELS[f.key] ?? f.key}</span>
            <span>
              {f.value}
              <em className="hint" style={{ marginLeft: 6 }}>
                {(f.confidence * 100).toFixed(0)}%
              </em>
            </span>
          </div>
        ))}
      </div>
      {(recipe.required.length > 0 || recipe.forbidden.length > 0) && (
        <div className="hint" style={{ marginTop: 8 }}>
          {recipe.required.length > 0 && <div>必须：{recipe.required.join('；')}</div>}
          {recipe.forbidden.length > 0 && <div>禁止：{recipe.forbidden.join('；')}</div>}
        </div>
      )}
    </div>
  );
}

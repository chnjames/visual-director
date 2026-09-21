/**
 * 试运行抽屉：单节点运行，或按连线拓扑跑整张图。
 * 有配方节点时必须先确认；没有配方节点时，生成只用提示词，并标明不是已确认配方。
 * 没有适配器的节点显示暂不可执行，不填假结果。
 * 成功/失败结果回写到项目 runs + assets，供运行记录与素材库展示。
 */
import { useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { isImageConfigured, isTextConfigured } from '../../shared/security';
import type { IdentityFeature, ModelSettings, VisualRecipe } from '../../shared/types';
import type { WorkflowGraph } from '../../workflow/graph/types';
import type { RepairProposal } from '../../workflow/workflowTypes';
import {
  describeRecipe,
  extractRecipe,
  generateAndAudit,
  graphHasRecipeSource,
  planNodeRuns,
  runConnectedGraph,
  readUploadedImages,
  type GenerationRun,
  type GraphRunState,
  type GraphStepLog,
  type NodeRunRow,
  type RecipeExtraction,
} from '../../workflow/graph/execute';
import { persistCanvasRun } from '../../data/persistCanvasRun';
import { emptyAnalysisMeta } from '../../workflow/graph/analysisMeta';
import { upsertAsset } from '../../data/assetStore';

export function TestRunDrawer({
  projectId,
  graph,
  settings,
  onOpenSettings,
  onClose,
  onConfirmRecipe,
  onConfirmIdentity,
  onConfirmRepair,
}: {
  projectId: string;
  graph: WorkflowGraph;
  settings: ModelSettings | null;
  configured: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
  /** 确认配方时写回闸门 / 兼容分析节点 */
  onConfirmRecipe?: (recipe: VisualRecipe) => void;
  /** 确认商品身份时写回身份闸门 */
  onConfirmIdentity?: (features: IdentityFeature[]) => void;
  onConfirmRepair?: (proposal: RepairProposal) => void;
}) {
  const rows = useMemo(() => planNodeRuns(graph), [graph]);
  const runnable = rows.filter((row) => row.action !== 'unavailable' && row.action !== 'source');
  const sources = rows.filter((row) => row.action === 'source');
  const blocked = rows.filter((row) => row.action === 'unavailable');
  const needsRecipe = useMemo(() => graphHasRecipeSource(graph), [graph]);
  const [busy, setBusy] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<RecipeExtraction | null>(null);
  const [confirmed, setConfirmed] = useState<VisualRecipe | null>(null);
  const [pendingIdentity, setPendingIdentity] = useState<IdentityFeature[] | null>(null);
  const [confirmedIdentity, setConfirmedIdentity] = useState<IdentityFeature[] | null>(null);
  const [pendingRepair, setPendingRepair] = useState<RepairProposal | null>(null);
  const [generated, setGenerated] = useState<GenerationRun | null>(null);
  const [graphSteps, setGraphSteps] = useState<GraphStepLog[]>([]);
  const [pausedState, setPausedState] = useState<GraphRunState | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const canModel = isTextConfigured(settings);
  const canImage = isImageConfigured(settings);
  const needsTextModel = runnable.some((row) =>
    ['extract', 'identity', 'audit', 'repair'].includes(row.action),
  );
  const canRunWorkflow = needsTextModel ? canModel && canImage : canImage;
  const canChain = runnable.some(
    (r) => r.action === 'extract' || r.action === 'generate' || r.action === 'prompt' || r.action === 'gate',
  );

  async function remember(input: Parameters<typeof persistCanvasRun>[0]) {
    try {
      const productImages = graph.nodes.flatMap((node) =>
        node.type === 'sceneGenerate'
          ? readUploadedImages(node.config.productImages)
          : node.type === 'productInput'
            ? readUploadedImages(node.config.images)
            : [],
      );
      for (const image of productImages) {
        await upsertAsset({
          projectId,
          kind: 'product',
          name: image.name,
          dataUri: image.dataUri,
          mediaType: image.mediaType,
          source: 'canvas-upload',
        });
      }
      await persistCanvasRun(input);
      setSavedHint(input.status === 'failed' ? '已记入运行记录（失败）' : '已写入运行记录与素材库');
    } catch {
      setSavedHint('本地回写失败，本次结果仅留在本面板');
    }
  }

  async function handleExtract(nodeId: string) {
    setBusy(nodeId);
    setConfirmed(null);
    setGenerated(null);
    setPausedState(null);
    setGraphError(null);
    setSavedHint(null);
    try {
      const result = await extractRecipe(graph, settings, undefined, nodeId);
      setExtracted(result);
      const row = rows.find((r) => r.nodeId === nodeId);
      await remember({
        projectId,
        kind: 'node',
        status: result.ok ? 'done' : 'failed',
        nodeId,
        nodeTitle: row?.title,
        message: result.ok ? '配方提取完成' : result.message,
        callsUsed: result.callsUsed,
      });
    } finally {
      setBusy(null);
    }
  }

  function handleConfirm() {
    if (!extracted || !extracted.ok) return;
    const next = { ...extracted.recipe, confirmedAt: new Date().toISOString() };
    setConfirmed(next);
    onConfirmRecipe?.(next);
  }

  async function handleGenerate(nodeId: string) {
    setBusy(nodeId);
    setGraphError(null);
    setSavedHint(null);
    try {
      const result = await generateAndAudit(graph, settings, needsRecipe ? confirmed : null, undefined, nodeId);
      setGenerated(result);
      const row = rows.find((r) => r.nodeId === nodeId);
      const hasImage = !!(result.ok ? result.imageDataUri : result.imageDataUri);
      await remember({
        projectId,
        kind: 'node',
        status: result.ok ? 'done' : hasImage ? 'partial' : 'failed',
        nodeId,
        nodeTitle: row?.title,
        generation: result,
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleChain(resume?: {
    recipe?: VisualRecipe;
    identity?: IdentityFeature[];
    repair?: RepairProposal;
  }) {
    setBusy('chain');
    setGraphError(null);
    setSavedHint(null);
    try {
      const recipe = resume?.recipe ?? (needsRecipe ? confirmed : null);
      const identity = resume?.identity ?? confirmedIdentity;
      const result = await runConnectedGraph(graph, settings, {
        confirmedRecipe: recipe,
        confirmedIdentity: identity,
        confirmedRepair: resume?.repair,
        resume: resume && pausedState ? pausedState : null,
      });
      setGraphSteps(result.state.steps);
      if (result.status === 'awaiting-confirm') {
        setPausedState(result.state);
        if (result.gate === 'recipe') {
          setExtracted({
            ok: true,
            recipe: result.recipe,
            purpose: result.purpose,
            summary: result.summary,
            suggestedPrompt: result.summary,
            meta: emptyAnalysisMeta(),
            callsUsed: result.state.callsUsed,
          });
          setConfirmed(null);
          setPendingIdentity(null);
        } else {
          if (result.gate === 'identity') {
            setPendingIdentity(result.features);
            setConfirmedIdentity(null);
            setPendingRepair(null);
          } else {
            setPendingRepair(result.proposal);
            setPendingIdentity(null);
          }
        }
        return;
      }
      setPausedState(null);
      if (result.status === 'failed') {
        setGraphError(result.message);
        await remember({
          projectId,
          kind: 'chain',
          status: 'failed',
          steps: result.state.steps,
          message: result.message,
          callsUsed: result.state.callsUsed,
        });
        return;
      }
      if (result.extraction) setExtracted(result.extraction);
      if (result.generation) setGenerated(result.generation);
      if (recipe?.confirmedAt) setConfirmed(recipe);
      const gen = result.generation;
      const hasImage = !!(gen && (gen.ok ? gen.imageDataUri : gen.imageDataUri));
      await remember({
        projectId,
        kind: 'chain',
        status: gen && !gen.ok && hasImage ? 'partial' : 'done',
        steps: result.state.steps,
        generation: gen,
        callsUsed: result.state.callsUsed,
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirmAndContinue() {
    if (!extracted || !extracted.ok) return;
    const next = { ...extracted.recipe, confirmedAt: new Date().toISOString() };
    setConfirmed(next);
    onConfirmRecipe?.(next);
    await handleChain({ recipe: next });
  }

  async function handleConfirmIdentityAndContinue() {
    if (!pendingIdentity?.length) return;
    const next = pendingIdentity.map((feature) => ({
      ...feature,
      status: feature.status === 'rejected' ? 'rejected' as const : 'confirmed' as const,
    }));
    setConfirmedIdentity(next);
    onConfirmIdentity?.(next);
    await handleChain({ identity: next });
  }

  async function handleConfirmRepairAndContinue() {
    if (!pendingRepair) return;
    onConfirmRepair?.(pendingRepair);
    await handleChain({ repair: pendingRepair });
  }

  return (
    <>
      <div className="testrun-scrim" onMouseDown={onClose} />
      <div className="testrun-drawer" role="dialog" aria-label="试运行" data-testid="testrun-drawer">
        <div className="testrun-head">
          <div>
            <strong><Play size={14} /> 试运行</strong>
            <span className="hint" style={{ marginLeft: 10 }}>
              {runnable.length ? `可运行 ${runnable.length} 个节点` : '图上没有可运行的节点'}
            </span>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭试运行" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="testrun-body">
          {runnable.length === 0 && sources.length === 0 && (
            <div className="empty-state">
              <h3>还不能试运行</h3>
              <p>这些节点可以编排和保存，但还没有执行适配器。不会用假结果填充。</p>
            </div>
          )}

          {(runnable.length > 0 || sources.length > 0) && !canRunWorkflow && (
            <div className="readonly-note" data-testid="testrun-nokey" style={{ marginBottom: 12 }}>
              {needsTextModel && !canModel
                ? '当前工作流含分析节点，需要同时配置文本模型和 Seedream 5.0。'
                : '尚未配置 Seedream 5.0。可以编辑画布，但不能出图。'}
              <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={onOpenSettings}>
                模型设置
              </button>
            </div>
          )}

          {(runnable.length > 0 || sources.length > 0) && (
            <>
              <ol className="testrun-steps">
                <li>可按连线一次跑通，也可单独跑某个节点。</li>
                <li>上游输出沿端口传给下游。没有适配器的节点跳过，不填假结果。</li>
                <li>图上有配方节点时，提取后会暂停，确认后继续出图。</li>
                <li>没有配方节点时，生成只用已连接的提示词，并标明这不是已确认配方。</li>
                <li>完成后会写入本项目的运行记录与素材库（生成图）。</li>
              </ol>

              {savedHint && (
                <p className="hint" data-testid="testrun-saved" style={{ marginBottom: 10 }}>
                  {savedHint}
                </p>
              )}

              {canChain && (
                <div className="btn-row" style={{ marginBottom: 12 }}>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!canRunWorkflow || busy !== null || (needsRecipe && !!pausedState && !confirmed)}
                    onClick={() => void handleChain()}
                    data-testid="testrun-chain"
                    title={!canImage ? '出图还需要图片 Endpoint；可先跑提取' : undefined}
                  >
                    {busy === 'chain' ? '正在按连线运行…' : '按连线运行'}
                  </button>
                </div>
              )}

              <div className="testrun-nodes">
                {runnable.map((row) => (
                  <NodeRun
                    key={row.nodeId}
                    row={row}
                    busy={busy}
                    canModel={canModel}
                    canImage={canImage}
                    needsRecipe={needsRecipe}
                    confirmed={!!confirmed}
                    onExtract={() => void handleExtract(row.nodeId)}
                    onGenerate={() => void handleGenerate(row.nodeId)}
                  />
                ))}
              </div>

              {needsRecipe && extracted?.ok && !pausedState && (
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null}
                    onClick={handleConfirm}
                    data-testid="testrun-confirm"
                  >
                    {confirmed ? '配方已确认' : '确认配方'}
                  </button>
                </div>
              )}

              {pausedState && extracted?.ok && !pendingIdentity && (
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy !== null}
                    onClick={() => void handleConfirmAndContinue()}
                    data-testid="testrun-confirm-continue"
                  >
                    {busy === 'chain' ? '继续运行中…' : '确认配方并继续'}
                  </button>
                </div>
              )}

              {pausedState && pendingIdentity && (
                <div className="section-card" data-testid="testrun-identity">
                  <h2>商品身份 · 等待确认</h2>
                  <ul className="testrun-blocked">
                    {pendingIdentity.map((feature) => (
                      <li key={feature.id}>{feature.statement}</li>
                    ))}
                  </ul>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy !== null}
                      onClick={() => void handleConfirmIdentityAndContinue()}
                      data-testid="testrun-confirm-identity-continue"
                    >
                      {busy === 'chain' ? '继续运行中…' : '确认身份并继续'}
                    </button>
                  </div>
                </div>
              )}

              {pausedState && pendingRepair && (
                <div className="section-card" data-testid="testrun-repair">
                  <h2>定向修复 · 等待确认</h2>
                  <p>{pendingRepair.reason}</p>
                  {pendingRepair.addedNegative.length > 0 && (
                    <p className="hint">新增负向约束：{pendingRepair.addedNegative.join('；')}</p>
                  )}
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy !== null}
                      onClick={() => void handleConfirmRepairAndContinue()}
                      data-testid="testrun-confirm-repair-continue"
                    >
                      {busy === 'chain' ? '修复重生成中…' : '确认修复并重生成'}
                    </button>
                  </div>
                </div>
              )}

              {graphSteps.length > 0 && (
                <div className="section-card" data-testid="testrun-graph-steps">
                  <h2>连线执行步骤</h2>
                  <ol className="testrun-graph-log">
                    {graphSteps.map((step, i) => (
                      <li key={`${step.nodeId}-${i}`} className={`step-${step.status}`}>
                        <strong>{step.title}</strong>
                        <span className="hint"> · {step.status}{step.message ? ` · ${step.message}` : ''}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {graphError && <p className="hint err">{graphError}</p>}
              {extracted && !extracted.ok && <p className="hint err">{extracted.message}</p>}
              {extracted?.ok && (
                <div className="section-card" data-testid="testrun-recipe">
                  <h2>视觉配方{confirmed ? ' · 已确认' : pausedState ? ' · 等待确认' : ' · 待确认'}</h2>
                  <pre className="readonly-box">{describeRecipe(extracted.recipe)}</pre>
                </div>
              )}
              {generated && !generated.ok && (
                <p className="hint err">
                  {generated.message}
                  {generated.imageDataUri ? ' 图片已生成，但验收没有完成。' : ''}
                </p>
              )}
              {generated?.ok && generated.auditSkippedReason && (
                <p className="hint">{generated.auditSkippedReason}</p>
              )}
              {generated?.ok && !generated.recipeBound && (
                <p className="hint">这次出图没有已确认配方，提示词就是节点上的原文。</p>
              )}
              {(() => {
                const resultImages =
                  generated?.images ??
                  (generated?.imageDataUri && generated.mediaType
                    ? [{ dataUri: generated.imageDataUri, mediaType: generated.mediaType }]
                    : []);
                if (!resultImages.length || !generated) return null;
                const audit = generated.ok ? generated.audit : null;
                return (
                  <div className="section-card" data-testid="testrun-image">
                    <h2>生成结果 · {resultImages.length} 张{audit ? ` · ${audit.status}` : ''}</h2>
                    <div className="asset-grid">
                      {resultImages.map((image, index) => (
                        <img
                          alt={`生成的场景图 ${index + 1}`}
                          src={image.dataUri}
                          style={{ maxWidth: '100%', borderRadius: 8 }}
                          key={`${image.dataUri.slice(-24)}-${index}`}
                        />
                      ))}
                    </div>
                    {audit && (
                      <p className="hint">
                        身份 {audit.identityScore} · 配方 {audit.recipeScore} · 任务 {audit.taskScore} · 技术 {audit.technicalScore}
                        {' · '}
                        {audit.statusReason}
                      </p>
                    )}
                  </div>
                );
              })()}

              {blocked.length > 0 && (
                <details className="tech-details">
                  <summary>其余 {blocked.length} 个节点暂不可执行</summary>
                  <ul className="testrun-blocked">
                    {blocked.map((row) => (
                      <li key={row.nodeId}>
                        {row.title} · {row.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function NodeRun({
  row,
  busy,
  canModel,
  canImage,
  needsRecipe,
  confirmed,
  onExtract,
  onGenerate,
}: {
  row: NodeRunRow;
  busy: string | null;
  canModel: boolean;
  canImage: boolean;
  needsRecipe: boolean;
  confirmed: boolean;
  onExtract: () => void;
  onGenerate: () => void;
}) {
  const running = busy === row.nodeId;
  return (
    <div className="testrun-node">
      <div>
        <strong>{row.title}</strong>
        <p className="hint">{row.detail}</p>
      </div>
      {row.action === 'extract' && (
        <button
          type="button"
          className="btn"
          disabled={!canModel || busy !== null}
          onClick={onExtract}
          data-testid="testrun-extract"
        >
          {running ? '正在提取…' : '提取配方'}
        </button>
      )}
      {row.action === 'identity' && <span className="hint">随连线提取</span>}
      {(row.action === 'gate' || row.action === 'identity-gate') && (
        <span className="hint">运行到此暂停确认</span>
      )}
      {row.action === 'prompt' && <span className="hint">随连线绑定</span>}
      {row.action === 'generate' && (
        <button
          type="button"
          className="btn primary"
          disabled={!canImage || busy !== null || (needsRecipe && !confirmed)}
          title={!canImage ? '还需要配置图片生成 Endpoint' : needsRecipe && !confirmed ? '请先确认配方' : undefined}
          onClick={onGenerate}
          data-testid="testrun-generate"
        >
          {running ? '正在生成…' : '生成'}
        </button>
      )}
      {row.action === 'audit' && <span className="hint">随连线或生成执行</span>}
      {row.action === 'repair' && <span className="hint">仅验收失败时执行</span>}
    </div>
  );
}

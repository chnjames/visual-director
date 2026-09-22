/**
 * 自定义工作流画布页（docs/12 专注布局）。
 * 组合：顶部项目栏、节点库浮层、FlowEditor、覆盖式检查器。
 * 本阶段：编辑、校验、发布，以及按节点适配器试运行。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useWorkflowDraft } from '../hooks/useWorkflowDraft';
import { FlowXyEditor } from '../components/flow/FlowXyEditor';
import { NodeLibraryPopover } from '../components/flow/NodeLibraryPopover';
import { NodeInspector } from '../components/flow/NodeInspector';
import { CanvasToolbar } from '../components/flow/CanvasToolbar';
import { optimizePrompt, type PromptOptimizationResult } from '../workflow/promptOptimization';
import { describeRecipe, extractRecipe, generateAndAudit, previewPromptNode, referenceImagesOf, runConnectedGraph, type GenerationRun } from '../workflow/graph/execute';
import { isSoloRunnableNode } from '../workflow/graph/adapters';
import { persistCanvasRun } from '../data/persistCanvasRun';
import { upsertAsset } from '../data/assetStore';
import { listVersions, publishVersion, PublishBlockedError, type WorkflowVersion } from '../data/versionStore';
import type { GraphIssue, NodeInstance } from '../workflow/graph/types';
import type { ModelSettings } from '../shared/types';
import {
  generationDefaultsToConfig,
  normalizeGenerationDefaults,
  purposeLabel,
  type GenerationDefaults,
} from '../workflow/generationOptions';
import { isImageConfigured, isTextConfigured } from '../shared/security';
import type { PreviewImage } from '../components/flow/ImageLightbox';
import {
  buildAnalyzeLog,
  buildGenerateLog,
  buildPromptLog,
  clearNodeRunFeedbackPatch,
  writeGenerateLocal,
  writeGenerateWorkflow,
} from '../workflow/graph/runIo';
import { autoFillPromptPatch, promptEditorsFedBy } from '../workflow/graph/promptText';

export type CanvasChrome = {
  versionText: string;
  publishDisabled: boolean;
  publishTitle: string;
  publishMsg: { kind: 'ok' | 'error'; text: string } | null;
  onPublish: () => void;
};

function imagesFromGeneration(generation: GenerationRun | null | undefined): PreviewImage[] {
  if (!generation) return [];
  if (generation.images?.length) {
    return generation.images.map((image) => ({
      dataUri: image.dataUri,
      mediaType: image.mediaType,
    }));
  }
  if (generation.imageDataUri && generation.mediaType) {
    return [{ dataUri: generation.imageDataUri, mediaType: generation.mediaType }];
  }
  return [];
}

export function WorkflowEditorPage({
  projectId,
  projectName,
  generationDefaults,
  configured,
  settings,
  onOpenSettings,
  onSaveState,
  onCanvasChrome,
}: {
  projectId: string;
  projectName: string;
  generationDefaults?: GenerationDefaults;
  configured: boolean;
  settings: ModelSettings | null;
  onOpenSettings: () => void;
  onSaveState?: (s: 'idle' | 'saving' | 'saved' | 'failed', savedAt?: number | null) => void;
  onCanvasChrome?: (chrome: CanvasChrome | null) => void;
}) {
  const d = useWorkflowDraft(projectId, projectName);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [latestVersion, setLatestVersion] = useState<WorkflowVersion | null>(null);
  const [publishMsg, setPublishMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
  const [graphRunning, setGraphRunning] = useState(false);
  const [completedNodeIds, setCompletedNodeIds] = useState<string[]>([]);
  const runningRef = useRef<string | null>(null);
  const [nodeRunPreview, setNodeRunPreview] = useState<{
    nodeId: string;
    images?: { dataUri: string; mediaType: string }[];
    message: string;
    status: 'ok' | 'error';
    errorClass?: string;
  } | null>(null);
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const viewportWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void listVersions(projectId).then((vs) => {
      if (alive && vs.length) setLatestVersion(vs[0]);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const handlePublish = useCallback(async () => {
    if (!d.draft) return;
    try {
      const v = await publishVersion({
        projectId,
        name: d.draft.name,
        graph: d.graph!,
      });
      setLatestVersion(v);
      setPublishMsg({ kind: 'ok', text: `已发布 v${v.versionNo}` });
    } catch (e) {
      if (e instanceof PublishBlockedError) {
        setPublishMsg({ kind: 'error', text: e.message });
      } else {
        setPublishMsg({ kind: 'error', text: '发布失败，请稍后重试' });
      }
    }
  }, [d.draft, d.graph, projectId]);

  useEffect(() => {
    onSaveState?.(d.saveState, d.savedAt);
  }, [d.saveState, d.savedAt, onSaveState]);

  useEffect(() => {
    const errorCount = d.validation.errors.length;
    onCanvasChrome?.({
      versionText: latestVersion
        ? `v${latestVersion.versionNo} · 有未发布改动`
        : '草稿 · 未发布',
      publishDisabled: errorCount > 0,
      publishTitle: errorCount > 0 ? '请先修复校验错误再发布' : '发布为不可变版本（批量任务可选用）',
      publishMsg,
      onPublish: () => void handlePublish(),
    });
    return () => onCanvasChrome?.(null);
  }, [d.validation.errors.length, handlePublish, latestVersion, onCanvasChrome, publishMsg]);

  // “/” 打开节点库
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        setLibraryOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const invalidNodeIds = useMemo(() => {
    const s = new Set<string>();
    d.validation.errors.forEach((i) => i.nodeId && s.add(i.nodeId));
    return s;
  }, [d.validation]);

  const closeInspector = useCallback(() => d.setSelection(null), [d]);

  const handleRunNode = useCallback(
    async (node: NodeInstance) => {
      if (!d.graph) return;
      const latest = d.graph.nodes.find((item) => item.id === node.id) ?? node;
      d.setSelection({ kind: 'node', id: latest.id });

      if (latest.type === 'referenceAnalyze' || latest.type === 'recipeExtractor') {
        if (!isTextConfigured(settings)) {
          setNodeRunPreview({
            nodeId: latest.id,
            message: '尚未配置文本模型，无法分析',
            status: 'error',
            errorClass: 'not-configured',
          });
          onOpenSettings();
          return;
        }
        setRunningNodeId(latest.id);
        setNodeRunPreview(null);
        d.updateNodeConfigs(latest.id, clearNodeRunFeedbackPatch());
        const started = Date.now();
        try {
          const result = await extractRecipe(d.graph, settings, undefined, latest.id);
          const durationMs = Date.now() - started;
          if (result.ok) {
            const log = buildAnalyzeLog({
              scope: 'node',
              node: latest,
              summary: result.summary,
              suggestedPrompt: result.suggestedPrompt,
              ok: true,
              durationMs,
            });
            d.updateNodeConfigs(latest.id, {
              analysisOutput: result.summary,
              lastRecipe: result.recipe,
              analysisMeta: result.meta,
              purpose: result.purpose || latest.config.purpose || '',
              suggestedPrompt: result.suggestedPrompt,
              lastRunOk: true,
              lastRunMessage: log.message,
              lastRunIo: log,
            });
            for (const editor of promptEditorsFedBy(d.graph, latest.id)) {
              const patch = autoFillPromptPatch(editor.config, result.suggestedPrompt);
              if (patch) d.updateNodeConfigs(editor.id, patch);
            }
            const message = result.meta.conflictHint
              ? `分析完成（有冲突提示）· 结果已写入检查器`
              : '分析完成，结果已写入检查器';
            setNodeRunPreview({ nodeId: latest.id, message, status: 'ok' });
            const refs = referenceImagesOf(d.graph, latest);
            for (const img of refs) {
              await upsertAsset({
                projectId,
                kind: 'reference',
                name: img.name || '参考图',
                dataUri: img.dataUri,
                mediaType: img.mediaType,
                source: 'canvas-upload',
                nodeId: latest.id,
              });
            }
            await persistCanvasRun({
              projectId,
              kind: 'node',
              status: 'done',
              nodeId: latest.id,
              nodeTitle: '参考图分析',
              message: result.meta.conflictHint || '配方提取完成',
              callsUsed: result.callsUsed,
            });
          } else {
            const log = buildAnalyzeLog({
              scope: 'node',
              node: latest,
              summary: result.message,
              ok: false,
              durationMs,
            });
            d.updateNodeConfigs(latest.id, {
              analysisOutput: result.message,
              lastRunOk: false,
              lastRunMessage: result.message,
              lastRunIo: log,
            });
            setNodeRunPreview({ nodeId: latest.id, message: result.message, status: 'error' });
            await persistCanvasRun({
              projectId,
              kind: 'node',
              status: 'failed',
              nodeId: latest.id,
              nodeTitle: '参考图分析',
              message: result.message,
              callsUsed: result.callsUsed,
            });
          }
        } catch (e) {
          const msg = (e as Error).message || '分析失败';
          d.updateNodeConfigs(latest.id, {
            analysisOutput: msg,
            lastRunOk: false,
            lastRunMessage: msg,
          });
          setNodeRunPreview({ nodeId: latest.id, message: msg, status: 'error' });
        } finally {
          setRunningNodeId(null);
        }
        return;
      }

      if (latest.type === 'promptEditor' || latest.type === 'promptCompiler') {
        setRunningNodeId(latest.id);
        setNodeRunPreview(null);
        d.updateNodeConfigs(latest.id, clearNodeRunFeedbackPatch());
        const started = Date.now();
        const preview = previewPromptNode(d.graph, latest.id);
        const durationMs = Date.now() - started;
        if (preview.ok) {
          const suggested = preview.positive;
          const fill = autoFillPromptPatch(latest.config, suggested);
          const log = buildPromptLog({
            scope: 'node',
            node: { ...latest, config: { ...latest.config, ...(fill ?? {}) } },
            positive: preview.positive,
            message: '已预览将送给生成节点的提示词',
            ok: true,
            durationMs,
          });
          d.updateNodeConfigs(latest.id, {
            ...(fill ?? {}),
            lastRunOk: true,
            lastRunMessage: log.message,
            lastRunIo: log,
          });
          setNodeRunPreview({ nodeId: latest.id, message: log.message, status: 'ok' });
        } else {
          const log = buildPromptLog({
            scope: 'node',
            node: latest,
            positive: '',
            message: preview.message,
            ok: false,
            durationMs,
          });
          d.updateNodeConfigs(latest.id, {
            lastRunOk: false,
            lastRunMessage: preview.message,
            lastRunIo: log,
          });
          setNodeRunPreview({ nodeId: latest.id, message: preview.message, status: 'error' });
        }
        setRunningNodeId(null);
        return;
      }

      if (latest.type === 'sceneGenerate' || latest.type === 'sceneGenerator') {
        if (!isImageConfigured(settings)) {
          setNodeRunPreview({
            nodeId: latest.id,
            message: '尚未配置 Seedream 5.0，无法出图',
            status: 'error',
            errorClass: 'not-configured',
          });
          onOpenSettings();
          return;
        }
        setRunningNodeId(latest.id);
        setNodeRunPreview(null);
        d.updateNodeConfigs(latest.id, clearNodeRunFeedbackPatch());
        const started = Date.now();
        try {
          const result = await generateAndAudit(d.graph, settings, null, undefined, latest.id);
          const images = result.ok
            ? result.images ??
              (result.imageDataUri && result.mediaType
                ? [{ dataUri: result.imageDataUri, mediaType: result.mediaType }]
                : [])
            : result.imageDataUri && result.mediaType
              ? [{ dataUri: result.imageDataUri, mediaType: result.mediaType }]
              : [];
          const message = result.ok
            ? `已生成 ${images.length || 1} 张`
            : result.message;
          writeGenerateLocal(
            d.updateNodeConfigs,
            latest.id,
            images,
            message,
            result.ok,
            buildGenerateLog({
              scope: 'node',
              node: latest,
              images,
              message,
              ok: result.ok,
              durationMs: Date.now() - started,
              graph: d.graph,
            }),
          );
          setNodeRunPreview({
            nodeId: latest.id,
            images,
            message,
            status: result.ok ? 'ok' : 'error',
            errorClass: result.ok ? undefined : result.errorClass,
          });
          try {
            await persistCanvasRun({
              projectId,
              kind: 'node',
              status: result.ok ? 'done' : images.length ? 'partial' : 'failed',
              nodeId: latest.id,
              nodeTitle: '商品场景生成',
              generation: result,
              images,
            });
          } catch (persistErr) {
            // 画布已有图；落库失败单独提示，不覆盖生成成功态
            const persistMsg = (persistErr as Error).message || '生成图落库失败';
            setNodeRunPreview({
              nodeId: latest.id,
              images,
              message: result.ok ? `${message}（${persistMsg}）` : message,
              status: result.ok ? 'ok' : 'error',
              errorClass: result.ok ? undefined : result.errorClass,
            });
          }
        } catch (e) {
          const msg = (e as Error).message || '生成失败';
          setNodeRunPreview({ nodeId: latest.id, message: msg, status: 'error' });
        } finally {
          setRunningNodeId(null);
        }
        return;
      }
    },
    [d, onOpenSettings, projectId, settings],
  );

  const handleRunWorkflow = useCallback(async () => {
    if (!d.graph) return;
    const graph = d.graph;
    const generate = graph.nodes.find(
      (node) => node.type === 'sceneGenerate' || node.type === 'sceneGenerator',
    );
    const extract = graph.nodes.find(
      (node) => node.type === 'referenceAnalyze' || node.type === 'recipeExtractor',
    );
    if (extract && !isTextConfigured(settings)) {
      d.updateNodeConfigs(extract.id, {
        lastRunOk: false,
        lastRunMessage: '尚未配置文本模型，无法分析',
      });
      d.setSelection({ kind: 'node', id: extract.id });
      setNodeRunPreview({
        nodeId: extract.id,
        message: '尚未配置文本模型，无法分析',
        status: 'error',
        errorClass: 'not-configured',
      });
      onOpenSettings();
      return;
    }
    if (generate && !isImageConfigured(settings)) {
      d.updateNodeConfigs(generate.id, {
        lastRunOk: false,
        lastRunMessage: '尚未配置 Seedream 5.0，无法出图',
      });
      d.setSelection({ kind: 'node', id: generate.id });
      setNodeRunPreview({
        nodeId: generate.id,
        message: '尚未配置 Seedream 5.0，无法出图',
        status: 'error',
        errorClass: 'not-configured',
      });
      onOpenSettings();
      return;
    }

    setGraphRunning(true);
    setCompletedNodeIds([]);
    runningRef.current = generate?.id ?? extract?.id ?? null;
    setRunningNodeId(runningRef.current);
    setNodeRunPreview(null);
    for (const node of graph.nodes) {
      if (
        node.type === 'referenceAnalyze' ||
        node.type === 'recipeExtractor' ||
        node.type === 'promptEditor' ||
        node.type === 'promptCompiler' ||
        node.type === 'sceneGenerate' ||
        node.type === 'sceneGenerator' ||
        node.type === 'resultGallery'
      ) {
        d.updateNodeConfigs(node.id, clearNodeRunFeedbackPatch());
      }
    }
    const started = Date.now();
    try {
      const result = await runConnectedGraph(graph, settings, {
        onNodeStart: (id) => {
          const prev = runningRef.current;
          if (prev && prev !== id) {
            setCompletedNodeIds((ids) => (ids.includes(prev) ? ids : [...ids, prev]));
          }
          runningRef.current = id;
          setRunningNodeId(id);
          d.updateNodeConfigs(id, clearNodeRunFeedbackPatch());
        },
      });
      if (result.status === 'failed') {
        const extraction = result.extraction;
        if (extraction?.ok && extract) {
          d.updateNodeConfigs(extract.id, {
            analysisOutput: extraction.summary,
            lastRecipe: extraction.recipe,
            analysisMeta: extraction.meta,
            purpose: extraction.purpose || extract.config.purpose || '',
            suggestedPrompt: extraction.suggestedPrompt,
            lastRunOk: true,
            lastRunIo: buildAnalyzeLog({
              scope: 'workflow',
              node: extract,
              summary: extraction.summary,
              suggestedPrompt: extraction.suggestedPrompt,
              ok: true,
              durationMs: Date.now() - started,
            }),
          });
          for (const editor of promptEditorsFedBy(graph, extract.id)) {
            const patch = autoFillPromptPatch(editor.config, extraction.suggestedPrompt);
            if (patch) d.updateNodeConfigs(editor.id, patch);
          }
        }
        const failedId = result.state.steps.find((step) => step.status === 'failed')?.nodeId ?? generate?.id;
        if (failedId) {
          d.updateNodeConfigs(failedId, {
            lastRunOk: false,
            lastRunMessage: result.message,
          });
          d.setSelection({ kind: 'node', id: failedId });
          setNodeRunPreview({
            nodeId: failedId,
            message: result.message,
            status: 'error',
          });
        }
        await persistCanvasRun({
          projectId,
          kind: 'chain',
          status: 'failed',
          steps: result.state.steps,
          message: result.message,
          callsUsed: result.state.callsUsed,
        });
        return;
      }
      if (result.status === 'awaiting-confirm') {
        const pausedId = result.state.pausedNodeId ?? extract?.id;
        if (pausedId && result.gate === 'recipe' && 'recipe' in result) {
          d.updateNodeConfigs(pausedId, {
            analysisOutput: result.summary,
            lastRecipe: result.recipe,
          });
          d.setSelection({ kind: 'node', id: pausedId });
          setNodeRunPreview({
            nodeId: pausedId,
            message: '请确认配方后再次运行',
            status: 'ok',
          });
        }
        return;
      }
      if (result.extraction?.ok && extract) {
        d.updateNodeConfigs(extract.id, {
          analysisOutput: result.extraction.summary,
          lastRecipe: result.extraction.recipe,
          analysisMeta: result.extraction.meta,
          purpose: result.extraction.purpose || extract.config.purpose || '',
          suggestedPrompt: result.extraction.suggestedPrompt,
          lastRunOk: true,
          lastRunIo: buildAnalyzeLog({
            scope: 'workflow',
            node: extract,
            summary: result.extraction.summary,
            suggestedPrompt: result.extraction.suggestedPrompt,
            ok: true,
            durationMs: Date.now() - started,
          }),
        });
        for (const editor of promptEditorsFedBy(graph, extract.id)) {
          const patch = autoFillPromptPatch(editor.config, result.extraction.suggestedPrompt);
          if (patch) d.updateNodeConfigs(editor.id, patch);
        }
      }
      const images = imagesFromGeneration(result.generation);
      const ok = !!result.generation?.ok;
      const message = ok
        ? `已生成 ${images.length || 1} 张`
        : result.generation && !result.generation.ok
          ? result.generation.message
          : '运行完成';
      if (generate) {
        writeGenerateWorkflow(
          d.updateNodeConfigs,
          graph,
          generate.id,
          images,
          message,
          ok,
          buildGenerateLog({
            scope: 'workflow',
            node: generate,
            images,
            message,
            ok,
            durationMs: Date.now() - started,
            graph,
          }),
        );
        setNodeRunPreview({
          nodeId: generate.id,
          images,
          message,
          status: ok ? 'ok' : 'error',
        });
      }
      try {
        await persistCanvasRun({
          projectId,
          kind: 'chain',
          status: ok ? 'done' : images.length ? 'partial' : 'failed',
          steps: result.state.steps,
          generation: result.generation,
          images,
          callsUsed: result.state.callsUsed,
        });
      } catch (persistErr) {
        const persistMsg = (persistErr as Error).message || '生成图落库失败';
        if (generate) {
          setNodeRunPreview({
            nodeId: generate.id,
            images,
            message: ok ? `${message}（${persistMsg}）` : message,
            status: ok ? 'ok' : 'error',
          });
        }
      }
    } catch (e) {
      const msg = (e as Error).message || '运行失败';
      if (generate) {
        writeGenerateLocal(
          d.updateNodeConfigs,
          generate.id,
          [],
          msg,
          false,
          buildGenerateLog({
            scope: 'workflow',
            node: generate,
            images: [],
            message: msg,
            ok: false,
            durationMs: Date.now() - started,
            graph,
          }),
        );
        setNodeRunPreview({ nodeId: generate.id, message: msg, status: 'error' });
      }
    } finally {
      setGraphRunning(false);
      setRunningNodeId(null);
      runningRef.current = null;
      setCompletedNodeIds([]);
    }
  }, [d, onOpenSettings, projectId, settings]);

  const handleOptimize = useCallback(
    async (originalPrompt: string, negativePrompt: string): Promise<
      { ok: true; data: PromptOptimizationResult } | { ok: false; message: string }
    > => {
      const reference = d.graph?.nodes.find((node) => node.type === 'referenceAnalyze');
      const recipe =
        reference?.config.lastRecipe &&
        typeof reference.config.lastRecipe === 'object'
          ? reference.config.lastRecipe
          : undefined;
      const r = await optimizePrompt(settings, {
        originalPrompt,
        negativePrompt,
        visualRecipe: recipe
          ? describeRecipe(recipe as Parameters<typeof describeRecipe>[0])
          : undefined,
        taskPurpose: purposeLabel(reference?.config.purpose) || String(reference?.config.purpose ?? ''),
      });
      if (r.ok) return { ok: true, data: r.data };
      return { ok: false, message: r.message };
    },
    [d.graph, settings],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        setLibraryOpen(false);
        d.setSelection(null);
        return;
      }
      if (typing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && d.selection) {
        e.preventDefault();
        d.removeSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && d.selection?.kind === 'node') {
        e.preventDefault();
        d.duplicateSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) d.redo();
        else d.undo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [d]);

  if (!d.ready || !d.graph) {
    return (
      <div className="workflow-editor loading" data-testid="workflow-loading">
        <div className="hint">正在打开工作流草稿…</div>
      </div>
    );
  }

  const errorCount = d.validation.errors.length;
  const warningCount = d.validation.warnings.length;

  const zoomIn = () => d.patchView({ zoom: Math.min(2.5, +(d.view.zoom * 1.15).toFixed(3)) });
  const zoomOut = () => d.patchView({ zoom: Math.max(0.2, +(d.view.zoom / 1.15).toFixed(3)) });
  const fitAll = () => setFitRequest((n) => n + 1);

  const runDisabledReason = errorCount
    ? '存在校验错误，无法运行'
    : '';

  return (
    <div className="workflow-editor" data-testid="workflow-editor">
      <CanvasToolbar
        canUndo={d.canUndo}
        canRedo={d.canRedo}
        zoom={d.view.zoom}
        onUndo={d.undo}
        onRedo={d.redo}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomTo={(next) => d.patchView({ zoom: Math.min(2.5, Math.max(0.2, next)) })}
        onFit={fitAll}
        onLayout={d.layout}
        miniMapOpen={miniMapOpen}
        onToggleMiniMap={() => setMiniMapOpen((open) => !open)}
        onAddNode={() => setLibraryOpen(true)}
        errorCount={errorCount}
        warningCount={warningCount}
        issuesOpen={issuesOpen}
        onToggleIssues={() => setIssuesOpen((open) => !open)}
        runDisabledReason={runDisabledReason}
        graphRunning={graphRunning}
        onRunWorkflow={() => void handleRunWorkflow()}
      />

      {issuesOpen && (errorCount > 0 || warningCount > 0) && (
        <div className={`validation-panel ${errorCount > 0 ? 'has-error' : ''}`} data-testid="validation-panel">
          <div className="validation-panel-head">
            <strong>
              <AlertTriangle size={13} />
              {errorCount > 0 ? `无法发布（${errorCount}）` : `警告（${warningCount}）`}
            </strong>
            <button type="button" className="icon-btn" aria-label="收起问题列表" onClick={() => setIssuesOpen(false)}>
              ✕
            </button>
          </div>
          {d.validation.errors.slice(0, 7).map((iss: GraphIssue, i) => (
            <button
              key={i}
              type="button"
              className="validation-row error"
              onClick={() => iss.nodeId && d.selectNode(iss.nodeId)}
            >
              <span className="run-no">{iss.code}</span>
              <span>{iss.message}</span>
            </button>
          ))}
          {d.validation.warnings.slice(0, 5).map((w, i) => (
            <div key={`w-${i}`} className="validation-row warning">
              <span className="run-no">{w.code}</span>
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      <div ref={viewportWrap} className="flow-editor-body">
        <FlowXyEditor
          graph={d.graph}
          view={d.view}
          selection={d.selection}
          onPatchView={d.patchView}
          onSelect={d.setSelection}
          onTransientMove={d.transientMove}
          onEndMove={d.endMove}
          onConnect={d.tryConnect}
          onConfigChange={d.updateNodeConfig}
          invalidNodeIds={invalidNodeIds}
          warningNodeIds={d.warningNodeIds}
          fitRequest={fitRequest}
          runningNodeId={runningNodeId}
          graphRunning={graphRunning}
          completedNodeIds={completedNodeIds}
          showMiniMap={miniMapOpen}
          onRunNode={(node) => void handleRunNode(node)}
        />
      </div>

      {libraryOpen && (
        <NodeLibraryPopover
          graph={d.graph}
          onClose={() => setLibraryOpen(false)}
          onAdd={(type, pos) => {
            const overrides =
              type === 'sceneGenerate'
                ? generationDefaultsToConfig(normalizeGenerationDefaults(generationDefaults))
                : undefined;
            const id = d.addNode(type, pos, overrides);
            if (id) setLibraryOpen(false);
          }}
          viewportCenter={() => {
            const el = viewportWrap.current?.querySelector('.flow-viewport') as HTMLElement | null;
            return { width: el?.clientWidth ?? 1000, height: el?.clientHeight ?? 600 };
          }}
          view={d.view}
        />
      )}

      {d.selection?.kind === 'node' && d.selectedNode && (
        <NodeInspector
          node={d.selectedNode}
          graph={d.graph}
          issues={[...d.validation.errors, ...d.validation.warnings, ...d.validation.hints]}
          onClose={closeInspector}
          onDelete={d.removeSelected}
          onDuplicate={d.duplicateSelected}
          onConfigChange={d.updateNodeConfig}
          onConfigsChange={d.updateNodeConfigs}
          onSelectNode={(id) => d.setSelection({ kind: 'node', id })}
          configured={configured}
          settings={settings}
          onOpenSettings={onOpenSettings}
          onRequestOptimize={handleOptimize}
          onRunNode={
            isSoloRunnableNode(d.selectedNode.type)
              ? () => void handleRunNode(d.selectedNode!)
              : undefined
          }
          running={runningNodeId === d.selectedNode.id || graphRunning}
          runPreview={nodeRunPreview?.nodeId === d.selectedNode.id ? nodeRunPreview : null}
        />
      )}
    </div>
  );
}

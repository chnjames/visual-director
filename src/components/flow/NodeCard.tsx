/**
 * 画布节点卡片（SellerPic 式，docs/12 §4 + 本轮 §3/§5）。
 *
 * - 高频配置（inline:true）直接内嵌在卡片：提示词、图片上传、比例、数量、模型；
 * - 端口圆点为真实 DOM，锚点位置由 FlowEditor 实测（data-port-id），不做高度推测；
 * - 高级设置/完整 IO/错误放右侧覆盖面板。
 */
import { useState } from 'react';
import { Images, ScanSearch, Lock, Braces, ImagePlus, ShieldCheck, Wrench, CheckCircle2,
  UploadCloud, Sparkles, Eraser, Replace, Maximize2, Wand2, Brush, Ratio, ListChecks,
  PencilLine, FileCheck2, type LucideIcon } from 'lucide-react';
import { getNodeDefinition } from '../../workflow/graph/registry';
import { isSoloRunnableNode } from '../../workflow/graph/adapters';
import { LIMITS } from '../../shared/constants';
import { ImageListControl } from './ImageListControl';
import { ImageLightbox, readPreviewImages, ZoomableThumbs } from './ImageLightbox';
import { readRunLog } from '../../workflow/graph/runIo';
import type { NodeConfigField, NodeInstance, WorkflowGraph } from '../../workflow/graph/types';
import {
  TARGET_USE_OPTIONS,
  fieldEnumLabel,
  generationOptionLabel,
  normalizeGenerationResolution,
} from '../../workflow/generationOptions';
import { connectedProductSource, connectedPromptEditor, promptEditorStatus, suggestedFromAnalyze, visiblePrompt } from '../../workflow/graph/promptText';

const TYPE_ICON: Record<string, LucideIcon> = {
  referenceAnalyze: ScanSearch,
  promptEditor: PencilLine,
  sceneGenerate: ImagePlus,
  auditExport: FileCheck2,
  resultGallery: Images,
  referenceInput: Images,
  productInput: Images,
  productImages: Images,
  batchProductInput: ListChecks,
  recipeExtractor: ScanSearch,
  referenceAnalyzer: ScanSearch,
  identityExtractor: Lock,
  promptReverse: Braces,
  recipeConfirmGate: ShieldCheck,
  identityConfirmGate: ShieldCheck,
  resultConfirmGate: CheckCircle2,
  promptCompiler: Braces,
  promptOptimizer: Wand2,
  negativePrompt: Braces,
  styleConstraint: Sparkles,
  sceneGenerator: ImagePlus,
  similarGenerator: ImagePlus,
  batchGenerator: ListChecks,
  backgroundRemove: Eraser,
  backgroundReplace: Replace,
  outpaint: Maximize2,
  enhance: Sparkles,
  inpaint: Brush,
  platformFit: Ratio,
  resultAuditor: ShieldCheck,
  identityAuditor: Lock,
  recipeAuditor: ScanSearch,
  technicalAuditor: ShieldCheck,
  targetedRepair: Wrench,
  finalSink: UploadCloud,
};

export const PORT_DOM_ID = (nodeId: string, side: 'in' | 'out', portId: string) =>
  `port-${side}-${nodeId}-${portId}`;

export function NodeCard({
  node,
  graph,
  selected,
  dimmed,
  invalid,
  warning,
  hoverPort,
  connectError,
  onNodeMouseDown,
  onSelect,
  onPortMouseDown,
  onPortEnter,
  onPortLeave,
  onPortUp,
  onConfigChange,
  onRunNode,
  running,
  mode = 'absolute',
}: {
  node: NodeInstance;
  graph: WorkflowGraph;
  selected: boolean;
  dimmed: boolean;
  invalid: boolean;
  warning: boolean;
  hoverPort: string | null;
  connectError: string | null;
  onNodeMouseDown: (e: React.MouseEvent, id: string) => void;
  onSelect: (s: { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null) => void;
  onPortMouseDown: (e: React.MouseEvent, nodeId: string, portId: string) => void;
  onPortEnter: (nodeId: string, portId: string) => void;
  onPortLeave: () => void;
  onPortUp: (nodeId: string, portId: string) => void;
  onConfigChange: (nodeId: string, key: string, value: unknown) => void;
  onRunNode?: (node: NodeInstance) => void;
  running?: boolean;
  /** absolute=自研画布；flow=React Flow 壳内，端口由 Handle 负责 */
  mode?: 'absolute' | 'flow';
}) {
  const def = getNodeDefinition(node.type);
  if (!def) return null;
  const Icon = TYPE_ICON[node.type] ?? Sparkles;
  const isPlanned = def.execution === 'planned';
  const inlineFields = def.configFields.filter((f) => f.inline);
  const outCount = (portId: string) => graph.edges.filter((e) => e.from.node === node.id && e.from.port === portId).length;
  const flow = mode === 'flow';

  return (
    <div
      className={`flow-node sellerpic-node ${selected ? 'selected' : ''} ${dimmed ? 'dimmed' : ''} ${invalid ? 'has-error' : ''} ${warning ? 'has-warning' : ''} ${flow ? 'flow-embedded' : ''}`}
      style={flow ? { width: 'var(--node-w, 280px)', position: 'relative', left: 'auto', top: 'auto' } : { left: node.position.x, top: node.position.y, width: 'var(--node-w, 280px)' }}
      onMouseDown={flow ? undefined : (e) => onNodeMouseDown(e, node.id)}
      onClick={
        flow
          ? (e) => {
              e.stopPropagation();
              const t = e.target as HTMLElement | null;
              if (t?.closest('button, input, textarea, select, label, a, .if-upload')) {
                return;
              }
              onSelect({ kind: 'node', id: node.id });
            }
          : undefined
      }
      data-testid={`node-${node.type}-${node.id}`}
      data-node-id={node.id}
    >
      {!flow && (
      <div className="fn-ports in">
        {def.inputs.map((p) => (
          <PortHandle
            key={`in-${p.portId}`}
            side="in"
            nodeId={node.id}
            portId={p.portId}
            label={p.label}
            dataType={p.dataType}
            hover={hoverPort === `${node.id}:${p.portId}`}
            bad={!!connectError && hoverPort === `${node.id}:${p.portId}`}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={() => onPortEnter(node.id, p.portId)}
            onMouseLeave={onPortLeave}
            onMouseUp={(e) => {
              e.stopPropagation();
              onPortUp(node.id, p.portId);
            }}
          />
        ))}
      </div>
      )}

      <div
        className="fn-head"
        onClick={(e) => {
          e.stopPropagation();
          onSelect({ kind: 'node', id: node.id });
        }}
      >
        <span className="fn-icon" aria-hidden><Icon size={14} /></span>
        <span className="fn-title">{def.title}</span>
        {isPlanned ? (
          <span className="fn-flag planned">规划中</span>
        ) : def.isHumanGate ? (
          <span className="fn-flag gate">人工确认</span>
        ) : (
          <span className="fn-flag ready">可执行</span>
        )}
      </div>

      {/* 高频内嵌配置 */}
      {inlineFields.length > 0 && (
        <div className="fn-inline nodrag nopan" onMouseDown={(e) => e.stopPropagation()}>
          {inlineFields.map((f) => (
            <InlineField
              key={f.key}
              field={f}
              value={node.config[f.key]}
              planned={isPlanned}
              onChange={(v) => onConfigChange(node.id, f.key, v)}
            />
          ))}
        </div>
      )}

      {node.type === 'sceneGenerate' && <GenerationNodeSummary node={node} graph={graph} />}
      {node.type === 'promptEditor' && <PromptEditorSummary node={node} />}
      {node.type === 'referenceAnalyze' && <AnalyzeNodeSummary node={node} />}

      <NodeOutputStrip node={node} />

      {/* 单独运行（可执行节点）；完整配置与结果在右侧抽屉 */}
      {!isPlanned && onRunNode && isSoloRunnableNode(node.type) && (
        <button
          type="button"
          className="fn-run nodrag"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRunNode(node);
          }}
          disabled={running}
          data-testid={`run-node-${node.type}`}
        >
          {running ? '运行中…' : '试运行'}
        </button>
      )}

      {invalid && <div className="fn-error-line">存在校验错误</div>}
      {!invalid &&
        node.type !== 'referenceAnalyze' &&
        typeof node.config.analysisOutput === 'string' &&
        node.config.analysisOutput && (
        <div className="fn-result-line nodrag" title={String(node.config.analysisOutput)}>
          {String(node.config.analysisOutput).slice(0, 80)}
          {String(node.config.analysisOutput).length > 80 ? '…' : ''}
        </div>
      )}

      {!flow && (
      <div className="fn-ports out">
        {def.outputs.map((p) => (
          <PortHandle
            key={`out-${p.portId}`}
            side="out"
            nodeId={node.id}
            portId={p.portId}
            label={p.label}
            dataType={p.dataType}
            count={outCount(p.portId)}
            onMouseDown={(e) => onPortMouseDown(e, node.id, p.portId)}
            onMouseUp={(e) => e.stopPropagation()}
          />
        ))}
      </div>
      )}
    </div>
  );
}

function NodeOutputStrip({ node }: { node: NodeInstance }) {
  const images = readPreviewImages(node.config.lastOutputImages);
  const failed = node.config.lastRunOk === false && typeof node.config.lastRunMessage === 'string';
  const log = readRunLog(node.config.lastRunIo);
  const logLine = log ? (
    <div className="fn-run-log">
      {log.scope === 'workflow' ? '整图' : '单节点'} · {log.ok ? '完成' : '失败'}
      {log.durationMs > 0 ? ` · ${(log.durationMs / 1000).toFixed(1)}s` : ''}
    </div>
  ) : null;
  if (node.type === 'resultGallery') {
    return (
      <div className="fn-output nodrag nopan" data-testid="gallery-output">
        {images.length ? (
          <ZoomableThumbs images={images} className="thumbs gallery-thumbs" altPrefix="结果" />
        ) : (
          <div className="fn-gallery-empty">整图运行后，生成图会显示在这里</div>
        )}
        {failed && <div className="fn-error-line">{String(node.config.lastRunMessage)}</div>}
        {logLine}
      </div>
    );
  }
  if (!images.length && !failed && !log) return null;
  return (
    <div className="fn-output nodrag nopan" data-testid={`node-output-${node.type}`}>
      {images.length > 0 && (
        <>
          <span className="fn-output-label">生成结果</span>
          <ZoomableThumbs images={images} altPrefix="生成结果" />
        </>
      )}
      {failed && <div className="fn-error-line">{String(node.config.lastRunMessage)}</div>}
      {logLine}
    </div>
  );
}

function readCardImages(value: unknown): Array<{ dataUri: string; name?: string }> {
  return Array.isArray(value)
    ? value.filter(
        (image): image is { dataUri: string; name?: string } =>
          !!image &&
          typeof image === 'object' &&
          typeof (image as { dataUri?: unknown }).dataUri === 'string',
      )
    : [];
}

function GenerationNodeSummary({ node, graph }: { node: NodeInstance; graph: WorkflowGraph }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const productSource = connectedProductSource(graph, node.id);
  const images = productSource
    ? (() => {
        const fromImages = readCardImages(productSource.config.images);
        return fromImages.length ? fromImages : readCardImages(productSource.config.productImages);
      })()
    : readCardImages(node.config.productImages);
  const promptSource = connectedPromptEditor(graph, node.id);
  const prompt = visiblePrompt(
    promptSource ? promptSource.config.positivePrompt : node.config.positivePrompt,
  );
  const targetUse = generationOptionLabel(
    TARGET_USE_OPTIONS,
    node.config.targetUse ?? 'main-scene',
  );
  const ratio = String(node.config.aspectRatio ?? '1:1');
  const resolution = normalizeGenerationResolution(node.config.resolution);
  const count = Math.min(4, Math.max(1, Number(node.config.count) || 1));
  const promptLine = promptSource
    ? prompt || '提示词来自上游节点，尚未填写'
    : prompt || '点击节点，在右侧完成商品图片生成配置';
  return (
    <div className="generation-summary">
      <div className="generation-summary-media">
        {images[0] ? (
          <button
            type="button"
            className="thumb-zoom generation-summary-shot"
            aria-label="放大查看商品图"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setPreviewIndex(0);
            }}
          >
            <img src={images[0].dataUri} alt="" />
          </button>
        ) : (
          <span className="generation-summary-empty"><ImagePlus size={18} /></span>
        )}
        <div>
          <strong>
            {productSource
              ? images.length
                ? `来自商品图 · ${images.length} 张`
                : '商品图来自上游，尚未上传'
              : images.length
                ? `${images.length} 张商品图`
                : '尚未上传商品图'}
          </strong>
          <span>{targetUse}</span>
        </div>
      </div>
      <p className={prompt ? '' : 'is-empty'} data-testid={promptSource ? 'generation-prompt-source' : undefined}>
        {promptSource ? `来自提示词编辑 · ${promptLine}` : promptLine}
      </p>
      <div className="generation-summary-spec">
        <span>{ratio}</span>
        <span>{resolution}</span>
        <span>{count} 张结果</span>
      </div>
      {previewIndex !== null && images[previewIndex] && (
        <ImageLightbox
          images={images.map((image) => ({
            dataUri: image.dataUri,
            mediaType: 'image/png',
            name: image.name,
          }))}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onIndex={setPreviewIndex}
        />
      )}
    </div>
  );
}

function PromptEditorSummary({ node }: { node: NodeInstance }) {
  const status = promptEditorStatus(node.config);
  const label =
    status === 'empty' ? '尚未填写提示词' : status === 'from-analysis' ? '已采用分析建议' : '已手改';
  const preview = visiblePrompt(node.config.positivePrompt);
  return (
    <div className="generation-summary" data-testid="prompt-editor-status">
      <p className={preview ? '' : 'is-empty'}>{preview ? `${label} · ${preview.slice(0, 48)}${preview.length > 48 ? '…' : ''}` : label}</p>
    </div>
  );
}

function AnalyzeNodeSummary({ node }: { node: NodeInstance }) {
  const suggested = suggestedFromAnalyze(node);
  return (
    <div className="generation-summary" data-testid="analyze-node-status">
      <p className={suggested ? '' : 'is-empty'}>
        {suggested ? '建议提示词已生成，打开检查器采用' : '上传参考图后试运行，生成建议提示词'}
      </p>
    </div>
  );
}

function PortHandle({
  side, nodeId, portId, label, dataType, hover, bad, count, onMouseDown, onMouseEnter, onMouseLeave, onMouseUp,
}: {
  side: 'in' | 'out';
  nodeId: string;
  portId: string;
  label: string;
  dataType: string;
  hover?: boolean;
  bad?: boolean;
  count?: number;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onMouseUp?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      id={PORT_DOM_ID(nodeId, side, portId)}
      className={`port2 port2-${side} ${hover ? (bad ? 'hover-bad' : 'hover-ok') : ''}`}
      data-port-node={nodeId}
      data-port-side={side}
      data-port-id={portId}
      title={`${label} · ${dataType}`}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseUp={onMouseUp}
    >
      {side === 'out' && count ? <span className="port2-count">{count}</span> : null}
      <span className="port2-dot" data-type={dataType} />
      <span className="port2-name">{label}</span>
    </div>
  );
}

/** 节点内嵌高频控件（紧凑 SellerPic 风格） */
function InlineField({
  field, value, onChange, planned = false,
}: {
  field: NodeConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
  planned?: boolean;
}) {
  const v = value ?? field.defaultValue;
  switch (field.dataType) {
    case 'prompt-editor':
      return (
        <div className="if-block nodrag" data-testid={`inline-${field.key}`} onMouseDown={(e) => e.stopPropagation()}>
          <textarea
            className="if-prompt"
            rows={3}
            value={String(v ?? '')}
            placeholder="描述你想生成的图片，或插入上游变量 {{visualRecipe}}…"
            onChange={(e) => onChange(e.target.value)}
          />
          <div className="if-prompt-foot">
            <div className="if-vars">
              {(field.variables ?? []).map((varName) => (
                <button
                  key={varName}
                  type="button"
                  className="if-var"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(`${String(v ?? '')}${String(v ?? '') && !String(v).endsWith('\n') ? '\n' : ''}${varName}`);
                  }}
                >
                  {varName}
                </button>
              ))}
            </div>
            <span className="if-optimize-hint">✨优化提示词</span>
          </div>
        </div>
      );
    case 'image-list': {
      const isProduct = field.key === 'productImages' || field.label.includes('商品');
      return (
        <ImageListControl
          value={v}
          max={typeof field.max === 'number' ? field.max : isProduct ? LIMITS.identityImagesMax : LIMITS.referenceImagesMax}
          addLabel={isProduct ? '上传商品图' : '上传参考图'}
          onChange={onChange}
          disabled={planned}
          disabledReason={planned ? '规划中节点暂不可执行，上传不会进入试运行' : undefined}
        />
      );
    }
    case 'select':
    case 'aspect-ratio':
    case 'resolution':
      return (
        <label className="if-row" onMouseDown={(e) => e.stopPropagation()}>
          <span className="if-label">{field.label}</span>
          <select value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={`inline-${field.key}`}>
            {(field.enumValues ?? []).map((o) => (
              <option key={o} value={o}>{fieldEnumLabel(field, o)}</option>
            ))}
          </select>
        </label>
      );
    case 'model-selector':
      return (
        <label className="if-row" onMouseDown={(e) => e.stopPropagation()}>
          <span className="if-label">模型</span>
          <select value={String(v ?? 'default')} onChange={(e) => onChange(e.target.value)} data-testid={`inline-${field.key}`}>
            {(field.enumValues ?? ['默认模型']).map((o) => <option key={o} value={o}>{o === 'default' ? '默认模型' : o}</option>)}
          </select>
        </label>
      );
    case 'number':
      return (
        <label className="if-row" onMouseDown={(e) => e.stopPropagation()}>
          <span className="if-label">{field.label}</span>
          <input
            type="number"
            value={v === '' ? '' : Number(v)}
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            data-testid={`inline-${field.key}`}
          />
        </label>
      );
    case 'text':
      return (
        <div className="if-purpose nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {field.enumValues && field.enumValues.length > 0 && (
            <div className="if-purpose-chips" data-testid={`inline-${field.key}-presets`}>
              {field.enumValues.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`if-purpose-chip ${String(v ?? '') === opt ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(opt);
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          <input
            className="if-text"
            type="text"
            value={String(v ?? '')}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            data-testid={`inline-${field.key}`}
          />
        </div>
      );
    case 'switch':
      return (
        <label className="if-row if-switch nodrag" onMouseDown={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={v !== false && v !== 'false' && v !== 0}
            onChange={(e) => onChange(e.target.checked)}
            data-testid={`inline-${field.key}`}
          />
          <span className="if-label">{field.label}</span>
        </label>
      );
    default:
      return null;
  }
}

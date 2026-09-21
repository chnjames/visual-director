/**
 * 单节点试运行 vs 整图运行的写入边界（对齐扣子）：
 * 单节点只更新当前节点；整图才把生成图写入结果展示。
 */
import {
  generationOptionLabel,
  normalizeGenerationResolution,
  purposeLabel,
  TARGET_USE_OPTIONS,
} from '../generationOptions';
import { connectedProductSource, visiblePrompt } from './promptText';
import type { NodeInstance, WorkflowGraph } from './types';

export type PreviewImage = {
  dataUri: string;
  mediaType: string;
  name?: string;
};

function readImages(value: unknown): PreviewImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const dataUri = (item as { dataUri?: unknown }).dataUri;
    if (typeof dataUri !== 'string') return [];
    const mediaType =
      typeof (item as { mediaType?: unknown }).mediaType === 'string'
        ? (item as { mediaType: string }).mediaType
        : 'image/png';
    const name =
      typeof (item as { name?: unknown }).name === 'string'
        ? (item as { name: string }).name
        : undefined;
    return [{ dataUri, mediaType, name }];
  });
}

export type RunScope = 'node' | 'workflow';

export type RunIoItem = {
  key: string;
  label: string;
  kind: 'image' | 'text';
  text?: string;
  images?: PreviewImage[];
};

export type NodeRunLog = {
  scope: RunScope;
  ok: boolean;
  message: string;
  finishedAt: string;
  durationMs: number;
  inputs: RunIoItem[];
  outputs: RunIoItem[];
};

export function readRunLog(value: unknown): NodeRunLog | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<NodeRunLog>;
  if (raw.scope !== 'node' && raw.scope !== 'workflow') return null;
  if (typeof raw.ok !== 'boolean' || typeof raw.message !== 'string') return null;
  return {
    scope: raw.scope,
    ok: raw.ok,
    message: raw.message,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : '',
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
    inputs: Array.isArray(raw.inputs) ? raw.inputs.filter(isRunIoItem) : [],
    outputs: Array.isArray(raw.outputs) ? raw.outputs.filter(isRunIoItem) : [],
  };
}

function isRunIoItem(item: unknown): item is RunIoItem {
  if (!item || typeof item !== 'object') return false;
  const raw = item as Partial<RunIoItem>;
  return typeof raw.key === 'string' && typeof raw.label === 'string' && (raw.kind === 'image' || raw.kind === 'text');
}

function productImagesOf(node: NodeInstance, graph?: WorkflowGraph): PreviewImage[] {
  if (graph) {
    const src = connectedProductSource(graph, node.id);
    if (src) {
      const fromImages = readImages(src.config.images);
      if (fromImages.length) return fromImages;
      return readImages(src.config.productImages);
    }
  }
  return readImages(node.config.productImages);
}

function referenceImagesOf(node: NodeInstance): PreviewImage[] {
  const fromImages = readImages(node.config.images);
  if (fromImages.length) return fromImages;
  return readImages(node.config.referenceImages);
}

export function connectedGalleries(graph: WorkflowGraph, fromNodeId: string) {
  const galleries = graph.nodes.filter((node) => node.type === 'resultGallery');
  const linked = galleries.filter((gallery) =>
    graph.edges.some((edge) => edge.from.node === fromNodeId && edge.to.node === gallery.id),
  );
  return linked.length ? linked : galleries;
}

export function buildGenerateLog(args: {
  scope: RunScope;
  node: NodeInstance;
  images: PreviewImage[];
  message: string;
  ok: boolean;
  durationMs: number;
  promptText?: string;
  graph?: WorkflowGraph;
}): NodeRunLog {
  const prompt = (args.promptText ?? String(args.node.config.positivePrompt ?? '')).trim();
  const ratio = String(args.node.config.aspectRatio ?? '1:1');
  const resolution = normalizeGenerationResolution(args.node.config.resolution);
  const count = Math.min(4, Math.max(1, Number(args.node.config.count) || 1));
  const target = generationOptionLabel(TARGET_USE_OPTIONS, args.node.config.targetUse ?? 'main-scene');
  const products = productImagesOf(args.node, args.graph);
  return {
    scope: args.scope,
    ok: args.ok,
    message: args.message,
    finishedAt: new Date().toISOString(),
    durationMs: args.durationMs,
    inputs: [
      { key: 'productImages', label: '商品图', kind: 'image', images: products },
      { key: 'prompt', label: '提示词', kind: 'text', text: prompt || '（未填写）' },
      { key: 'spec', label: '规格', kind: 'text', text: `${target} · ${ratio} · ${resolution} · ${count} 张` },
    ],
    outputs: [{ key: 'images', label: '生成图', kind: 'image', images: args.images }],
  };
}

export function buildAnalyzeLog(args: {
  scope: RunScope;
  node: NodeInstance;
  summary: string;
  ok: boolean;
  durationMs: number;
  suggestedPrompt?: string;
}): NodeRunLog {
  const purpose = String(args.node.config.purpose ?? '').trim();
  const outputs: RunIoItem[] = args.suggestedPrompt
    ? [{ key: 'suggestedPrompt', label: '建议提示词', kind: 'text', text: args.suggestedPrompt }]
    : [{ key: 'analysis', label: '分析结果', kind: 'text', text: args.summary }];
  return {
    scope: args.scope,
    ok: args.ok,
    message: args.ok ? '分析完成' : args.summary,
    finishedAt: new Date().toISOString(),
    durationMs: args.durationMs,
    inputs: [
      { key: 'referenceImages', label: '参考图', kind: 'image', images: referenceImagesOf(args.node) },
      { key: 'purpose', label: '用途', kind: 'text', text: purposeLabel(purpose) || purpose || '（未填写）' },
    ],
    outputs,
  };
}

export function buildPromptLog(args: {
  scope: RunScope;
  node: NodeInstance;
  positive: string;
  message: string;
  ok: boolean;
  durationMs: number;
}): NodeRunLog {
  return {
    scope: args.scope,
    ok: args.ok,
    message: args.message,
    finishedAt: new Date().toISOString(),
    durationMs: args.durationMs,
    inputs: [
      {
        key: 'positivePrompt',
        label: '当前提示词',
        kind: 'text',
        text: visiblePrompt(args.node.config.positivePrompt) || '（空）',
      },
    ],
    outputs: [{
      key: 'preview',
      label: '将送给生成节点',
      kind: 'text',
      text: visiblePrompt(args.positive) || '（空）',
    }],
  };
}

export function generateNodePatch(
  images: PreviewImage[],
  message: string,
  ok: boolean,
  log: NodeRunLog,
): Record<string, unknown> {
  return {
    resultImages: message,
    lastOutputImages: images,
    lastRunMessage: message,
    lastRunOk: ok,
    lastRunIo: log,
  };
}

/** 开跑前清掉卡片上的旧成功/失败态，避免「运行中」与上次错误叠在一起。 */
export function clearNodeRunFeedbackPatch(): Record<string, unknown> {
  return {
    lastRunOk: null,
    lastRunMessage: null,
    lastRunIo: null,
  };
}

export function galleryNodePatch(images: PreviewImage[], message: string, ok: boolean, log: NodeRunLog): Record<string, unknown> {
  return {
    lastOutputImages: images,
    lastRunMessage: message,
    lastRunOk: ok,
    lastRunIo: {
      ...log,
      scope: 'workflow',
      inputs: [{ key: 'images', label: '上游生成图', kind: 'image', images }],
      outputs: [{ key: 'images', label: '展示', kind: 'image', images }],
    },
  };
}

export function writeGenerateLocal(
  update: (nodeId: string, patch: Record<string, unknown>) => void,
  nodeId: string,
  images: PreviewImage[],
  message: string,
  ok: boolean,
  log: NodeRunLog,
) {
  update(nodeId, generateNodePatch(images, message, ok, log));
}

export function writeGenerateWorkflow(
  update: (nodeId: string, patch: Record<string, unknown>) => void,
  graph: WorkflowGraph,
  generateNodeId: string,
  images: PreviewImage[],
  message: string,
  ok: boolean,
  log: NodeRunLog,
) {
  writeGenerateLocal(update, generateNodeId, images, message, ok, { ...log, scope: 'workflow' });
  for (const gallery of connectedGalleries(graph, generateNodeId)) {
    update(gallery.id, galleryNodePatch(images, message, ok, log));
  }
}

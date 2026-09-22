/**
 * 按节点适配器 + 连线端口执行。
 *
 * 图上有配方节点时，未确认不能生成；已确认配方是硬约束，用户提示词只作补充。
 * 图上没有配方节点时，生成只用已连接的提示词，并标明这不是已确认配方。
 * 商品图作为内联参考图送入图片接口；没有真实结果时不填充分数或图片。
 */
import { LIMITS } from '../../shared/constants';
import { isImageConfigured, isTextConfigured } from '../../shared/security';
import type {
  AuditResult,
  IdentityFeature,
  ModelErrorClass,
  ModelSettings,
  UploadedImage,
  VisualRecipe,
} from '../../shared/types';
import { compilePrompt } from '../promptCompiler';
import { defaultRunners, type Runners } from '../orchestrator';
import type { CompiledPrompt, RepairProposal } from '../workflowTypes';
import { createPromptSpec, promptTextForGeneration } from '../promptSpec';
import { purposeLabel } from '../generationOptions';
import { isHighRiskAudit } from '../workflowSchema';
import { getNodeAdapterSpec } from './adapters';
import { compileExecutionPlan } from './executionPlan';
import { getNodeDefinition } from './registry';
import type { NodeInstance, WorkflowGraph } from './types';
import {
  heuristicAnalysisMeta,
  mergeAnalysisMeta,
  parseAnalysisMeta,
  type ReferenceAnalysisMeta,
} from './analysisMeta';
import {
  bindAndFinalizePrompt,
  canAutoFillPrompt,
  connectedProductSource,
  connectedPromptEditor,
  describeRecipe,
  isVacantPrompt,
  isVisualRecipe,
  recipeToSuggestedPrompt,
  stripPromptVariables,
} from './promptText';

export { bindPrompt, describeRecipe } from './promptText';

export type StandardRunners =
  & Pick<Runners, 'recipe' | 'image' | 'audit'>
  & Partial<Pick<Runners, 'identity' | 'repair'>>;

export type RecipeExtraction =
  | {
      ok: true;
      recipe: VisualRecipe;
      purpose: string;
      summary: string;
      suggestedPrompt: string;
      meta: ReferenceAnalysisMeta;
      callsUsed: number;
    }
  | { ok: false; message: string; callsUsed: number };

export type GenerationRun =
  | {
      ok: true;
      positivePrompt: string;
      negativePrompt: string;
      imageDataUri: string;
      mediaType: string;
      images?: Array<{ dataUri: string; mediaType: string }>;
      audit: AuditResult | null;
      /** false：这次没有已确认配方，提示词就是用户原文 */
      recipeBound: boolean;
      auditSkippedReason?: string;
      callsUsed: number;
    }
  | {
      ok: false;
      message: string;
      callsUsed: number;
      errorClass?: ModelErrorClass;
      /** 图已生成但验收失败时保留，避免把已付费的结果丢掉 */
      imageDataUri?: string;
      mediaType?: string;
      images?: Array<{ dataUri: string; mediaType: string }>;
    };

const EXTRACT_TYPES = new Set(['referenceAnalyze', 'recipeExtractor']);
const GENERATE_TYPES = new Set(['sceneGenerate', 'sceneGenerator']);
const PROMPT_TYPES = new Set(['promptEditor', 'promptCompiler']);
const GATE_TYPES = new Set(['recipeConfirmGate']);
const REF_SOURCE_TYPES = new Set(['referenceAnalyze', 'referenceInput']);
const PRODUCT_SOURCE_TYPES = new Set(['productInput', 'productImages', 'sceneGenerate', 'sceneGenerator']);

export type NodeAction =
  | 'extract'
  | 'identity'
  | 'prompt'
  | 'generate'
  | 'audit'
  | 'repair'
  | 'source'
  | 'gate'
  | 'identity-gate'
  | 'sink';

export type NodeRunRow = {
  nodeId: string;
  type: string;
  title: string;
  action: NodeAction | 'unavailable';
  detail: string;
};

const ACTION_DETAIL: Record<NodeAction, string> = {
  source: '把节点上的素材写入出端口，供下游连线使用。',
  extract: '从参考图提取配方。结果需人工确认后才能当硬约束。',
  identity: '从商品图提取身份候选。候选需人工确认后才能成为硬约束。',
  gate: '人工确认配方后，才把已确认配方写到出端口。',
  'identity-gate': '人工确认商品身份候选后，才把硬约束写到出端口。',
  prompt: '读取上游配方/用途，绑定节点里的提示词模板。',
  generate: '按入边上的提示词出图。上游有配方节点时，必须先确认。',
  audit: '用商品图对照入边上的生成图。没有已确认配方或商品图时不验收。',
  repair: '验收失败时生成受限修复方案；确认后最多重生成一次。',
  sink: '接收终稿图与验收结论，作为定稿出口。',
};

export type PortValue =
  | { kind: 'images'; images: UploadedImage[] }
  | { kind: 'purpose'; text: string }
  | { kind: 'recipe'; recipe: VisualRecipe }
  | { kind: 'identity'; features: IdentityFeature[] }
  | {
      kind: 'prompt';
      positive: string;
      negative: string;
      compiledFromFacts?: boolean;
      compiled?: CompiledPrompt;
    }
  | {
      kind: 'image';
      dataUri: string;
      mediaType: string;
      images?: Array<{ dataUri: string; mediaType: string }>;
    }
  | { kind: 'audit'; audit: AuditResult }
  | { kind: 'repair'; proposal: RepairProposal };

export type GraphPorts = Record<string, PortValue>;

export type GraphStepLog = {
  nodeId: string;
  title: string;
  status: 'ok' | 'skipped' | 'failed' | 'paused';
  message?: string;
};

export type GraphRunState = {
  ports: GraphPorts;
  steps: GraphStepLog[];
  callsUsed: number;
  /** 暂停节点；恢复时从此节点继续，已完成的模型步骤不会重复调用。 */
  pausedNodeId?: string;
};

export type GraphRunResult =
  | {
      status: 'done';
      state: GraphRunState;
      extraction: RecipeExtraction | null;
      generation: GenerationRun | null;
    }
  | {
      status: 'awaiting-confirm';
      gate: 'recipe';
      state: GraphRunState;
      recipe: VisualRecipe;
      purpose: string;
      summary: string;
    }
  | {
      status: 'awaiting-confirm';
      gate: 'identity';
      state: GraphRunState;
      features: IdentityFeature[];
      summary: string;
    }
  | {
      status: 'awaiting-confirm';
      gate: 'repair';
      state: GraphRunState;
      proposal: RepairProposal;
      summary: string;
    }
  | { status: 'failed'; state: GraphRunState; message: string; extraction?: RecipeExtraction | null; generation?: GenerationRun | null };

/** 图上是否有会产出配方的节点。有的话，生成前必须确认。 */
export function graphHasRecipeSource(graph: WorkflowGraph): boolean {
  return graph.nodes.some(
    (n) => n.type === 'recipeExtractor' || n.type === 'recipeConfirmGate',
  );
}

export function planNodeRuns(graph: WorkflowGraph): NodeRunRow[] {
  return graph.nodes.map((node) => {
    const def = getNodeDefinition(node.type);
    const title = def?.title ?? node.type;
    const action = adapterOf(node.type);
    if (action) {
      return { nodeId: node.id, type: node.type, title, action, detail: ACTION_DETAIL[action] };
    }
    return {
      nodeId: node.id,
      type: node.type,
      title,
      action: 'unavailable',
      detail: def?.execution === 'planned' ? '规划中，暂不可执行' : '还没有执行适配器',
    };
  });
}

export function hasRunnableNode(graph: WorkflowGraph): boolean {
  return graph.nodes.some((n) => {
    const a = adapterOf(n.type);
    return (
      a === 'extract' ||
      a === 'identity' ||
      a === 'generate' ||
      a === 'audit' ||
      a === 'repair' ||
      a === 'prompt' ||
      a === 'gate' ||
      a === 'identity-gate'
    );
  });
}

function adapterOf(type: string): NodeAction | null {
  const action = getNodeAdapterSpec(type)?.action;
  switch (action) {
    case 'source':
      return 'source';
    case 'extract-recipe':
      return 'extract';
    case 'confirm-recipe':
      return 'gate';
    case 'extract-identity':
      return 'identity';
    case 'confirm-identity':
      return 'identity-gate';
    case 'compile-prompt':
      return 'prompt';
    case 'generate':
      return 'generate';
    case 'audit':
      return 'audit';
    case 'repair':
      return 'repair';
    case 'sink':
      return 'sink';
    default:
      return null;
  }
}

const STANDARD_MAINLINE_TYPES = [
  'productImages',
  'promptEditor',
  'referenceAnalyze',
  'resultGallery',
  'sceneGenerate',
].join(',');

/** 上一版四节点主线：商品图还写在生成节点上 */
const PREVIOUS_MAINLINE_TYPES = [
  'promptEditor',
  'referenceAnalyze',
  'resultGallery',
  'sceneGenerate',
].join(',');

const ADVANCED_COMPAT_TYPES = [
  'finalSink',
  'identityConfirmGate',
  'identityExtractor',
  'productInput',
  'promptCompiler',
  'recipeConfirmGate',
  'recipeExtractor',
  'referenceInput',
  'resultAuditor',
  'sceneGenerator',
  'targetedRepair',
].join(',');

/** 旧四节点主线（兼容识别） */
const LEGACY_MAINLINE_TYPES = ['auditExport', 'promptEditor', 'referenceAnalyze', 'sceneGenerate'].join(',');

export function isStandardMainline(graph: WorkflowGraph): boolean {
  const types = graph.nodes.map((n) => n.type).sort().join(',');
  return (
    types === STANDARD_MAINLINE_TYPES ||
    types === PREVIOUS_MAINLINE_TYPES ||
    types === ADVANCED_COMPAT_TYPES ||
    types === LEGACY_MAINLINE_TYPES
  );
}

export function findNode(graph: WorkflowGraph, type: string) {
  return graph.nodes.find((n) => n.type === type);
}

export function readUploadedImages(value: unknown): UploadedImage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isUploadedImage);
}

function isUploadedImage(v: unknown): v is UploadedImage {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.dataUri === 'string' &&
    o.dataUri.startsWith('data:') &&
    typeof o.mediaType === 'string' &&
    typeof o.name === 'string'
  );
}

export function portKey(nodeId: string, portId: string): string {
  return `${nodeId}::${portId}`;
}

/** Kahn 拓扑序。有环时返回 null。 */
export function topoSort(graph: WorkflowGraph): string[] | null {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  const outs = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!indeg.has(e.from.node) || !indeg.has(e.to.node)) continue;
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
    const list = outs.get(e.from.node) ?? [];
    list.push(e.to.node);
    outs.set(e.from.node, list);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outs.get(id) ?? []) {
      const d = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

function nodeById(graph: WorkflowGraph, id: string | undefined): NodeInstance | undefined {
  if (!id) return undefined;
  return graph.nodes.find((n) => n.id === id);
}

function firstOf(graph: WorkflowGraph, types: Set<string>, nodeId?: string): NodeInstance | undefined {
  const picked = nodeById(graph, nodeId);
  if (picked && types.has(picked.type)) return picked;
  return graph.nodes.find((n) => types.has(n.type));
}

function upstreamNodes(graph: WorkflowGraph, nodeId: string): NodeInstance[] {
  return graph.edges
    .filter((e) => e.to.node === nodeId)
    .map((e) => graph.nodes.find((n) => n.id === e.from.node))
    .filter((n): n is NodeInstance => !!n);
}

function readPort(ports: GraphPorts, graph: WorkflowGraph, nodeId: string, portId: string): PortValue | undefined {
  const edge = graph.edges.find((e) => e.to.node === nodeId && e.to.port === portId);
  if (!edge) return undefined;
  return ports[portKey(edge.from.node, edge.from.port)];
}

function writePort(ports: GraphPorts, nodeId: string, portId: string, value: PortValue) {
  ports[portKey(nodeId, portId)] = value;
}

export function referenceImagesOf(graph: WorkflowGraph, node: NodeInstance, ports?: GraphPorts): UploadedImage[] {
  if (ports) {
    const fromEdge =
      readPort(ports, graph, node.id, 'refs') ?? readPort(ports, graph, node.id, 'images');
    if (fromEdge?.kind === 'images' && fromEdge.images.length) return fromEdge.images;
  }
  const own = readUploadedImages(node.config.images);
  if (own.length) return own;
  for (const src of upstreamNodes(graph, node.id)) {
    const imgs = readUploadedImages(src.config.images);
    if (imgs.length) return imgs;
  }
  return [];
}

function imagesOnProductSource(src: NodeInstance): UploadedImage[] {
  const fromImages = readUploadedImages(src.config.images);
  if (fromImages.length) return fromImages;
  return readUploadedImages(src.config.productImages);
}

function productImagesOf(graph: WorkflowGraph, node: NodeInstance, ports?: GraphPorts): UploadedImage[] {
  const productEdge = graph.edges.find((edge) => edge.to.node === node.id && edge.to.port === 'products');
  if (productEdge) {
    if (ports) {
      const fromEdge = readPort(ports, graph, node.id, 'products');
      if (fromEdge?.kind === 'images') return fromEdge.images;
    }
    const src = graph.nodes.find((item) => item.id === productEdge.from.node);
    return src ? imagesOnProductSource(src) : [];
  }
  const own = readUploadedImages(node.config.productImages);
  if (own.length) return own;
  for (const src of upstreamNodes(graph, node.id)) {
    const imgs = imagesOnProductSource(src);
    if (imgs.length) return imgs;
  }
  const generator = graph.nodes.find((n) => GENERATE_TYPES.has(n.type));
  return readUploadedImages(generator?.config.productImages);
}

function purposeOf(graph: WorkflowGraph, ports?: GraphPorts, nodeId?: string): string {
  if (ports && nodeId) {
    const fromEdge = readPort(ports, graph, nodeId, 'purpose');
    if (fromEdge?.kind === 'purpose' && fromEdge.text) return fromEdge.text;
  }
  for (const n of graph.nodes) {
    if (!REF_SOURCE_TYPES.has(n.type)) continue;
    const text = String(n.config.purpose ?? '').trim();
    if (text) return text;
  }
  return '';
}

function connectedPrompt(
  graph: WorkflowGraph,
  generateId: string,
  ports?: GraphPorts,
): { positive: string; negative: string; compiledFromFacts?: boolean } | null {
  if (ports) {
    const fromEdge = readPort(ports, graph, generateId, 'prompt');
    if (fromEdge?.kind === 'prompt') {
      const positive = stripPromptVariables(fromEdge.positive);
      if (positive) {
        return {
          positive,
          negative: fromEdge.negative,
          compiledFromFacts: fromEdge.compiledFromFacts,
        };
      }
    }
  }
  const editor = upstreamNodes(graph, generateId).find((n) => PROMPT_TYPES.has(n.type));
  if (editor) {
    const raw = String(editor.config.positivePrompt ?? '');
    if (isVacantPrompt(raw)) return null;
    const vars = promptVarsOf(graph, editor, ports);
    const positive = bindAndFinalizePrompt(raw, vars);
    if (!positive) return null;
    return {
      positive,
      negative: String(editor.config.negativePrompt ?? '').trim(),
    };
  }
  const generate = nodeById(graph, generateId);
  if (!generate) return null;
  const raw = String(generate.config.positivePrompt ?? '');
  if (isVacantPrompt(raw)) return null;
  const positive = stripPromptVariables(raw);
  if (!positive) return null;
  return {
    positive,
    negative: String(generate.config.negativePrompt ?? '').trim(),
  };
}

function promptVarsOf(
  graph: WorkflowGraph,
  editor: NodeInstance,
  ports?: GraphPorts,
): { visualRecipe: string; taskPurpose: string; productImages: string; recipe: VisualRecipe | null } {
  const recipePort = ports ? readPort(ports, graph, editor.id, 'recipe') : null;
  const recipe =
    (recipePort?.kind === 'recipe' ? recipePort.recipe : null) ??
    upstreamRecipeOf(graph, editor);
  const purposePort = ports ? readPort(ports, graph, editor.id, 'purpose') : null;
  const purpose =
    (purposePort?.kind === 'purpose' ? purposePort.text : '') ||
    purposeOf(graph, ports, editor.id);
  return {
    visualRecipe: recipe ? describeRecipe(recipe) : '（无分析结果）',
    taskPurpose: purposeLabel(purpose) || purpose || '（未填写用途）',
    productImages: '未提供商品图。',
    recipe,
  };
}

function upstreamRecipeOf(graph: WorkflowGraph, editor: NodeInstance): VisualRecipe | null {
  const edge = graph.edges.find((item) => item.to.node === editor.id && item.to.port === 'recipe');
  if (!edge) return null;
  const src = graph.nodes.find((node) => node.id === edge.from.node);
  if (!src) return null;
  return isVisualRecipe(src.config.lastRecipe) ? src.config.lastRecipe : null;
}

function missingProductMessage(generate: NodeInstance, graph: WorkflowGraph): string {
  const src = connectedProductSource(graph, generate.id);
  if (src) {
    const title = getNodeDefinition(src.type)?.title ?? '上游';
    return `请在「${title}」节点上传至少 1 张商品图。`;
  }
  if (generate.type === 'sceneGenerate') {
    return '请在商品场景生成节点上传至少 1 张商品图。';
  }
  return '请上传至少 1 张商品图。';
}

function missingPromptMessage(generate: NodeInstance, graph: WorkflowGraph): string {
  if (connectedPromptEditor(graph, generate.id)) {
    return '请在「提示词编辑与优化」填写提示词，或先运行参考图分析并采用建议。';
  }
  if (generate.type === 'sceneGenerate') {
    return '请在商品场景生成节点填写提示词。';
  }
  return '请把提示词接到这个生成节点，或在生成节点填写提示词。';
}

function seedSourcePorts(graph: WorkflowGraph, ports: GraphPorts) {
  for (const node of graph.nodes) {
    if (REF_SOURCE_TYPES.has(node.type)) {
      const images = readUploadedImages(node.config.images);
      if (images.length) {
        if (node.type === 'referenceAnalyze') writePort(ports, node.id, 'refs', { kind: 'images', images });
        else writePort(ports, node.id, 'images', { kind: 'images', images });
      }
      const purpose = String(node.config.purpose ?? '').trim();
      if (purpose) writePort(ports, node.id, 'purpose', { kind: 'purpose', text: purpose });
    }
    if (PRODUCT_SOURCE_TYPES.has(node.type)) {
      const fromImageList = node.type === 'productInput' || node.type === 'productImages';
      const images = fromImageList
        ? readUploadedImages(node.config.images)
        : readUploadedImages(node.config.productImages);
      if (images.length) {
        if (fromImageList) writePort(ports, node.id, 'images', { kind: 'images', images });
        else writePort(ports, node.id, 'products', { kind: 'images', images });
      }
    }
  }
}

function titleOf(node: NodeInstance): string {
  return getNodeDefinition(node.type)?.title ?? node.type;
}

export async function extractRecipe(
  graph: WorkflowGraph,
  settings: ModelSettings | null,
  runners: StandardRunners = defaultRunners,
  nodeId?: string,
): Promise<RecipeExtraction> {
  const analyze = firstOf(graph, EXTRACT_TYPES, nodeId);
  if (!analyze) {
    return { ok: false, message: '图上没有可提取配方的节点。', callsUsed: 0 };
  }
  if (!isTextConfigured(settings)) {
    return { ok: false, message: '尚未配置文本模型，不能提取配方。', callsUsed: 0 };
  }
  const images = referenceImagesOf(graph, analyze);
  if (images.length < LIMITS.referenceImagesMin || images.length > LIMITS.referenceImagesMax) {
    return {
      ok: false,
      message: `请先上传 ${LIMITS.referenceImagesMin}–${LIMITS.referenceImagesMax} 张参考图。`,
      callsUsed: 0,
    };
  }
  const purpose = String(analyze.config.purpose ?? '').trim() || purposeOf(graph);
  const excludeSubject = excludeSubjectOf(graph, analyze);
  const res = await runners.recipe(settings, images, {
    purpose: purposeLabel(purpose) || purpose,
    excludeSubject,
  });
  if (!res.ok) return { ok: false, message: res.message, callsUsed: 1 };
  const recipe: VisualRecipe = { ...res.data, confirmedAt: undefined };
  const fromModel = res.raw?.rawContent ? parseAnalysisMeta(tryParseJsonObject(res.raw.rawContent), images) : null;
  const meta = mergeAnalysisMeta(heuristicAnalysisMeta(purpose, images, recipe), fromModel);
  const summaryParts = [describeRecipe(recipe)];
  if (meta.conflictHint) summaryParts.push(`冲突提示：${meta.conflictHint}`);
  const suggestedPrompt = recipeToSuggestedPrompt(recipe, purpose);
  return {
    ok: true,
    recipe,
    purpose,
    summary: summaryParts.join('\n\n'),
    suggestedPrompt,
    meta,
    callsUsed: 1,
  };
}

function tryParseJsonObject(text: string): unknown {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function excludeSubjectOf(graph: WorkflowGraph, node: NodeInstance): boolean {
  if (typeof node.config.excludeSubject === 'boolean') return node.config.excludeSubject;
  if (typeof node.config.sceneOnly === 'boolean') return node.config.sceneOnly;
  for (const src of upstreamNodes(graph, node.id)) {
    if (!REF_SOURCE_TYPES.has(src.type)) continue;
    if (typeof src.config.excludeSubject === 'boolean') return src.config.excludeSubject;
    if (typeof src.config.sceneOnly === 'boolean') return src.config.sceneOnly;
  }
  return true;
}

function isConfirmedRecipe(value: unknown): value is VisualRecipe {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as VisualRecipe).confirmedAt === 'string' &&
    Array.isArray((value as VisualRecipe).fields)
  );
}

/** 优先读闸门已确认配方；兼容旧路径读分析节点 lastRecipe */
export function confirmedRecipeFromGraph(graph: WorkflowGraph): VisualRecipe | null {
  for (const n of graph.nodes) {
    if (n.type === 'recipeConfirmGate' && isConfirmedRecipe(n.config.confirmedRecipe)) {
      return n.config.confirmedRecipe;
    }
  }
  for (const n of graph.nodes) {
    if (!EXTRACT_TYPES.has(n.type)) continue;
    if (isConfirmedRecipe(n.config.lastRecipe)) return n.config.lastRecipe;
  }
  return null;
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

/** 从身份闸门读取已确认硬约束；旧草稿没有该字段时返回空。 */
export function confirmedIdentityFromGraph(graph: WorkflowGraph): IdentityFeature[] {
  const gate = graph.nodes.find((node) => node.type === 'identityConfirmGate');
  if (!gate || !isIdentityFeatureList(gate.config.confirmedFeatures)) return [];
  return gate.config.confirmedFeatures.filter((feature) => feature.status === 'confirmed');
}

export async function generateAndAudit(
  graph: WorkflowGraph,
  settings: ModelSettings | null,
  recipe: VisualRecipe | null,
  runners: StandardRunners = defaultRunners,
  nodeId?: string,
  ports?: GraphPorts,
): Promise<GenerationRun> {
  const generate = firstOf(graph, GENERATE_TYPES, nodeId);
  if (!generate) {
    return { ok: false, message: '图上没有可生成的节点。', callsUsed: 0 };
  }
  if (!isImageConfigured(settings)) {
    return { ok: false, message: '尚未配置图片生成 Endpoint，不能出图。', callsUsed: 0 };
  }

  const needsRecipe = graphHasRecipeSource(graph);
  if (needsRecipe && !recipe?.confirmedAt) {
    return { ok: false, message: '请先确认视觉配方，再生成场景图。', callsUsed: 0 };
  }

  const prompt = connectedPrompt(graph, generate.id, ports);
  if (!prompt) {
    return { ok: false, message: missingPromptMessage(generate, graph), callsUsed: 0 };
  }

  const purpose = purposeOf(graph, ports, generate.id);
  const productImages = productImagesOf(graph, generate, ports);
  if (generate.type === 'sceneGenerate' && productImages.length < 1) {
    return {
      ok: false,
      message: missingProductMessage(generate, graph),
      callsUsed: 0,
    };
  }
  const productNote =
    productImages.length > 0
      ? `已提供 ${productImages.length} 张商品图，仅用于验收对照，不会作为参考图送入图片接口。`
      : '未提供商品图。';

  let positivePrompt: string;
  let negativePrompt: string;
  if (needsRecipe && recipe?.confirmedAt) {
    if (prompt.compiledFromFacts) {
      positivePrompt = prompt.positive;
      negativePrompt = prompt.negative;
    } else {
    const recipeText = describeRecipe(recipe);
    const userText = bindAndFinalizePrompt(prompt.positive, {
      visualRecipe: recipeText,
      taskPurpose: purposeLabel(purpose) || purpose,
      productImages: productNote,
    });
    let compiled;
    try {
      compiled = compilePrompt(recipe, [], purpose);
    } catch (e) {
      return { ok: false, message: (e as Error).message, callsUsed: 0 };
    }
    positivePrompt = userText
      ? `${compiled.positivePrompt}\n\n用户补充（不得覆盖上述已确认配方）：\n${userText}`
      : compiled.positivePrompt;
    negativePrompt = [compiled.negativePrompt, prompt.negative].filter(Boolean).join('\n');
    }
  } else {
    const userText = bindAndFinalizePrompt(prompt.positive, {
      visualRecipe: '（无已确认配方）',
      taskPurpose: purposeLabel(purpose) || purpose || '（未填写用途）',
      productImages: productNote,
    });
    if (!userText) {
      return { ok: false, message: missingPromptMessage(generate, graph), callsUsed: 0 };
    }
    positivePrompt = userText;
    negativePrompt = prompt.negative;
  }

  const promptSpec = createPromptSpec({
    positive: positivePrompt,
    negative: negativePrompt,
    targetUse: String(generate.config.targetUse ?? 'main-scene'),
    provenance: prompt?.compiledFromFacts
      ? ['reference-analysis', 'workflow']
      : ['manual'],
  });
  positivePrompt = promptTextForGeneration(promptSpec);
  negativePrompt = promptSpec.negative;

  const size = generationSize(
    String(generate.config.aspectRatio ?? '1:1'),
    String(generate.config.resolution ?? '1K'),
  );
  const count = Math.min(4, Math.max(1, Number(generate.config.count) || 1));
  const imgRes = await runners.image(settings, positivePrompt, negativePrompt, {
    productImages,
    size,
    count,
  });
  if (!imgRes.ok) return { ok: false, message: imgRes.message, errorClass: imgRes.errorClass, callsUsed: 1 };

  const images = (imgRes.images?.length
    ? imgRes.images
    : [{ b64Json: imgRes.b64Json, mediaType: imgRes.mediaType }]
  ).map((image) => ({
    dataUri: `data:${image.mediaType};base64,${image.b64Json}`,
    mediaType: image.mediaType,
  }));
  const imageDataUri = images[0].dataUri;
  const recipeBound = !!(needsRecipe && recipe?.confirmedAt);
  if (!recipeBound) {
    return {
      ok: true,
      positivePrompt,
      negativePrompt,
      imageDataUri,
      mediaType: imgRes.mediaType,
      images,
      audit: null,
      recipeBound: false,
      auditSkippedReason: '这次没有已确认配方，验收未执行。',
      callsUsed: 1,
    };
  }
  if (productImages.length < 1) {
    return {
      ok: true,
      positivePrompt,
      negativePrompt,
      imageDataUri,
      mediaType: imgRes.mediaType,
      images,
      audit: null,
      recipeBound: true,
      auditSkippedReason: '未上传商品图，无法对照商品身份，验收未执行。',
      callsUsed: 1,
    };
  }

  const candidate: UploadedImage = {
    id: 'generated',
    dataUri: imageDataUri,
    mediaType: imgRes.mediaType,
    name: 'generated.png',
  };
  const boundRecipe = recipe;
  if (!boundRecipe?.confirmedAt) {
    return {
      ok: false,
      message: '请先确认视觉配方，再生成场景图。',
      callsUsed: 1,
      imageDataUri,
      mediaType: imgRes.mediaType,
      images,
    };
  }
  const auditRes = await runners.audit(settings, productImages, candidate, boundRecipe, purpose);
  if (!auditRes.ok) {
    return {
      ok: false,
      message: auditRes.message,
      callsUsed: 2,
      imageDataUri,
      mediaType: imgRes.mediaType,
      images,
    };
  }
  return {
    ok: true,
    positivePrompt,
    negativePrompt,
    imageDataUri,
    mediaType: imgRes.mediaType,
    images,
    audit: auditRes.data,
    recipeBound: true,
    callsUsed: 2,
  };
}

export function generationSize(aspectRatio: string, resolution: string): string {
  const key = String(resolution ?? '').toUpperCase();
  const tier = key === '3K' ? '3K' : key === '2K' ? '2K' : '1K';
  const sizes: Record<string, Record<string, string>> = {
    '1K': {
      '1:1': '1024x1024',
      '3:4': '864x1152',
      '4:3': '1152x864',
      '16:9': '1424x800',
      '9:16': '800x1424',
    },
    '2K': {
      '1:1': '2048x2048',
      '3:4': '1728x2304',
      '4:3': '2304x1728',
      '16:9': '2848x1600',
      '9:16': '1600x2848',
    },
    '3K': {
      '1:1': '3072x3072',
      '3:4': '2592x3456',
      '4:3': '3456x2592',
      '16:9': '4096x2304',
      '9:16': '2304x4096',
    },
  };
  return sizes[tier][aspectRatio] ?? sizes[tier]['1:1'];
}

function bindPromptNode(graph: WorkflowGraph, node: NodeInstance, ports: GraphPorts): string | null {
  const recipePort = readPort(ports, graph, node.id, 'recipe');
  const identityPort = readPort(ports, graph, node.id, 'features');
  const purposePort = readPort(ports, graph, node.id, 'purpose');
  const recipe = recipePort?.kind === 'recipe' ? recipePort.recipe : null;
  const identityFeatures =
    identityPort?.kind === 'identity'
      ? identityPort.features.filter((feature) => feature.status === 'confirmed')
      : [];
  const purpose =
    (purposePort?.kind === 'purpose' ? purposePort.text : '') || purposeOf(graph, ports, node.id);
  const recipeText = recipe ? describeRecipe(recipe) : '（无分析结果）';
  const suggested = recipe ? recipeToSuggestedPrompt(recipe, purpose) : '';
  const raw = String(node.config.positivePrompt ?? '');
  let userPositive = isVacantPrompt(raw)
    ? ''
    : bindAndFinalizePrompt(raw, {
        visualRecipe: recipeText,
        taskPurpose: purposeLabel(purpose) || purpose || '（未填写用途）',
        productImages: '未提供商品图。',
      });
  if (node.type === 'promptEditor' && !userPositive && canAutoFillPrompt(node.config) && suggested) {
    userPositive = suggested;
  }
  const negative = String(node.config.negativePrompt ?? '').trim();
  if (!userPositive) return '请填写提示词，或先运行参考图分析。';

  if (node.type === 'promptCompiler' && recipe?.confirmedAt) {
    const compiled = compilePrompt(recipe, identityFeatures, purpose);
    const positive = userPositive
      ? `${compiled.positivePrompt}\n\n用户补充（不得覆盖上述已确认事实）：\n${userPositive}`
      : compiled.positivePrompt;
    const negativePrompt = [compiled.negativePrompt, negative].filter(Boolean).join('\n');
    writePort(ports, node.id, 'prompt', {
      kind: 'prompt',
      positive,
      negative: negativePrompt,
      compiledFromFacts: true,
      compiled: {
        ...compiled,
        positivePrompt: positive,
        negativePrompt,
      },
    });
    return null;
  }

  writePort(ports, node.id, 'prompt', {
    kind: 'prompt',
    positive: userPositive,
    negative,
    compiledFromFacts: false,
  });
  return null;
}

/** 提示词节点单跑：绑定/预览最终正文，不调用图片模型。 */
export function previewPromptNode(
  graph: WorkflowGraph,
  nodeId: string,
): { ok: true; positive: string; negative: string } | { ok: false; message: string } {
  const node = nodeById(graph, nodeId);
  if (!node || !PROMPT_TYPES.has(node.type)) {
    return { ok: false, message: '不是提示词节点' };
  }
  const ports: GraphPorts = {};
  seedSourcePorts(graph, ports);
  for (const src of upstreamNodes(graph, node.id)) {
    if (isVisualRecipe(src.config.lastRecipe)) {
      writePort(ports, src.id, 'recipe', { kind: 'recipe', recipe: src.config.lastRecipe });
    }
  }
  const err = bindPromptNode(graph, node, ports);
  if (err) return { ok: false, message: err };
  const bound = ports[portKey(node.id, 'prompt')];
  if (!bound || bound.kind !== 'prompt') return { ok: false, message: '没有可预览的提示词' };
  return { ok: true, positive: bound.positive, negative: bound.negative };
}

/**
 * 按拓扑序沿连线运行。提取到未确认配方且下游还有生成时暂停；
 * 传入 confirmedRecipe 后从暂停处继续，不再重复调用提取。
 */
export async function runConnectedGraph(
  graph: WorkflowGraph,
  settings: ModelSettings | null,
  options: {
    runners?: StandardRunners;
    confirmedRecipe?: VisualRecipe | null;
    confirmedIdentity?: IdentityFeature[] | null;
    confirmedRepair?: RepairProposal | null;
    resume?: GraphRunState | null;
    /** 整图运行时按拓扑进入每个节点；用于画布连线动效，不改变执行结果。 */
    onNodeStart?: (nodeId: string) => void;
  } = {},
): Promise<GraphRunResult> {
  const runners = options.runners ?? defaultRunners;
  let order: string[];
  try {
    order = compileExecutionPlan(graph).steps.map((step) => step.nodeInstanceId);
  } catch (error) {
    return {
      status: 'failed',
      state: { ports: {}, steps: [], callsUsed: 0 },
      message: error instanceof Error ? error.message : '工作流不能编译为执行计划。',
    };
  }

  const state: GraphRunState = options.resume
    ? {
        ports: { ...options.resume.ports },
        steps: [],
        callsUsed: options.resume.callsUsed,
        pausedNodeId: options.resume.pausedNodeId,
      }
    : { ports: {}, steps: [], callsUsed: 0 };

  if (!options.resume) seedSourcePorts(graph, state.ports);

  let extraction: RecipeExtraction | null = null;
  let generation: GenerationRun | null = null;
  const fail = (message: string): Extract<GraphRunResult, { status: 'failed' }> => ({
    status: 'failed',
    state,
    message,
    extraction,
    generation,
  });
  const confirmed =
    (options.confirmedRecipe?.confirmedAt ? options.confirmedRecipe : null) ??
    confirmedRecipeFromGraph(graph);
  const confirmedIdentity =
    options.confirmedIdentity?.filter((feature) => feature.status === 'confirmed') ??
    confirmedIdentityFromGraph(graph);
  const skipExtract = !!confirmed;
  let resumeAt = options.resume?.pausedNodeId;

  for (const nodeId of order) {
    if (resumeAt && nodeId !== resumeAt) continue;
    if (resumeAt === nodeId) {
      resumeAt = undefined;
      state.pausedNodeId = undefined;
    }
    const node = nodeById(graph, nodeId);
    if (!node) continue;
    options.onNodeStart?.(nodeId);
    const action = adapterOf(node.type);
    const title = titleOf(node);

    if (!action) {
      state.steps.push({ nodeId, title, status: 'skipped', message: '暂不可执行' });
      continue;
    }

    if (action === 'source') {
      state.steps.push({ nodeId, title, status: 'ok', message: '素材已写入出端口' });
      continue;
    }

    if (action === 'extract') {
      const localRecipe = node.config.lastRecipe as VisualRecipe | undefined;
      const localConfirmed =
        localRecipe && typeof localRecipe.confirmedAt === 'string' ? localRecipe : null;
      const useRecipe = (skipExtract && confirmed) || localConfirmed;
      if (useRecipe) {
        const recipe = localConfirmed ?? confirmed!;
        writePort(state.ports, node.id, 'recipe', { kind: 'recipe', recipe });
        const purpose = purposeOf(graph, state.ports, node.id) || String(node.config.purpose ?? '').trim();
        if (purpose) writePort(state.ports, node.id, 'purpose', { kind: 'purpose', text: purpose });
        const images = referenceImagesOf(graph, node, state.ports);
        if (images.length) writePort(state.ports, node.id, 'refs', { kind: 'images', images });
        state.steps.push({ nodeId, title, status: 'ok', message: '使用已确认配方' });
        continue;
      }
      const res = await extractRecipe(graph, settings, runners, node.id);
      state.callsUsed += res.callsUsed;
      if (!res.ok) {
        state.steps.push({ nodeId, title, status: 'failed', message: res.message });
        return fail(res.message);
      }
      extraction = res;
      node.config.suggestedPrompt = res.suggestedPrompt;
      node.config.lastRecipe = res.recipe;
      node.config.analysisOutput = res.summary;
      node.config.analysisMeta = res.meta;
      writePort(state.ports, node.id, 'recipe', { kind: 'recipe', recipe: res.recipe });
      if (res.purpose) writePort(state.ports, node.id, 'purpose', { kind: 'purpose', text: res.purpose });
      const images = referenceImagesOf(graph, node, state.ports);
      if (images.length) writePort(state.ports, node.id, 'refs', { kind: 'images', images });

      const extractIdx = order.indexOf(nodeId);
      const hasDownstreamGenerate = order.slice(extractIdx + 1).some((id) => {
        const n = nodeById(graph, id);
        return !!n && GENERATE_TYPES.has(n.type);
      });
      const hasDownstreamGate = order.slice(extractIdx + 1).some((id) => {
        const n = nodeById(graph, id);
        return !!n && GATE_TYPES.has(n.type);
      });
      // 有确认闸门时，在闸门处暂停；旧四节点无闸门时仍在提取节点暂停
      if (
        node.type !== 'referenceAnalyze' &&
        hasDownstreamGenerate &&
        !confirmed &&
        !hasDownstreamGate
      ) {
        state.pausedNodeId = node.id;
        state.steps.push({ nodeId, title, status: 'paused', message: '等待确认配方' });
        return {
          status: 'awaiting-confirm',
          gate: 'recipe',
          state,
          recipe: res.recipe,
          purpose: res.purpose,
          summary: res.summary,
        };
      }
      state.steps.push({
        nodeId,
        title,
        status: 'ok',
        message: node.type === 'referenceAnalyze' ? '分析完成，建议提示词已生成' : '配方已提取（待确认）',
      });
      continue;
    }

    if (action === 'gate') {
      const incoming = readPort(state.ports, graph, node.id, 'recipe');
      const fromConfig = isConfirmedRecipe(node.config.confirmedRecipe)
        ? node.config.confirmedRecipe
        : null;
      const recipe =
        confirmed ??
        fromConfig ??
        (incoming?.kind === 'recipe' && incoming.recipe.confirmedAt ? incoming.recipe : null);
      if (!recipe?.confirmedAt) {
        const pending =
          (incoming?.kind === 'recipe' ? incoming.recipe : null) ??
          (extraction && extraction.ok ? extraction.recipe : null);
        if (!pending) {
          state.steps.push({ nodeId, title, status: 'failed', message: '没有待确认配方' });
          return fail('没有待确认配方');
        }
        const purpose =
          purposeOf(graph, state.ports, node.id) ||
          (extraction && extraction.ok ? extraction.purpose : '');
        const summary =
          extraction && extraction.ok ? extraction.summary : describeRecipe(pending);
        state.pausedNodeId = node.id;
        state.steps.push({ nodeId, title, status: 'paused', message: '等待确认配方' });
        return {
          status: 'awaiting-confirm',
          gate: 'recipe',
          state,
          recipe: pending,
          purpose,
          summary,
        };
      }
      writePort(state.ports, node.id, 'recipe', { kind: 'recipe', recipe });
      state.steps.push({ nodeId, title, status: 'ok', message: '配方已确认' });
      continue;
    }

    if (action === 'identity') {
      if (confirmedIdentity.length) {
        writePort(state.ports, node.id, 'features', {
          kind: 'identity',
          features: confirmedIdentity,
        });
        state.steps.push({ nodeId, title, status: 'ok', message: '使用已确认商品身份' });
        continue;
      }
      if (!isTextConfigured(settings)) {
        const message = '尚未配置文本模型，不能提取商品身份。';
        state.steps.push({ nodeId, title, status: 'failed', message });
        return fail(message);
      }
      const products = productImagesOf(graph, node, state.ports);
      if (
        products.length < LIMITS.identityImagesMin ||
        products.length > LIMITS.identityImagesMax
      ) {
        const message = `请先上传 ${LIMITS.identityImagesMin}–${LIMITS.identityImagesMax} 张同一商品多角度图。`;
        state.steps.push({ nodeId, title, status: 'failed', message });
        return fail(message);
      }
      const statement =
        purposeOf(graph, state.ports, node.id) ||
        String(node.config.protectAttrs ?? '').trim() ||
        '保持商品形状、颜色、材质、结构与 Logo';
      if (!runners.identity) {
        const message = '商品身份节点缺少执行适配器。';
        state.steps.push({ nodeId, title, status: 'failed', message });
        return fail(message);
      }
      const result = await runners.identity(settings, products, statement);
      state.callsUsed += 1;
      if (!result.ok) {
        state.steps.push({ nodeId, title, status: 'failed', message: result.message });
        return fail(result.message);
      }
      const candidates = result.data.map((feature) => ({ ...feature, status: 'pending' as const }));
      writePort(state.ports, node.id, 'features', {
        kind: 'identity',
        features: candidates,
      });
      state.steps.push({ nodeId, title, status: 'ok', message: `已提取 ${candidates.length} 条身份候选` });
      continue;
    }

    if (action === 'identity-gate') {
      const incoming = readPort(state.ports, graph, node.id, 'features');
      const fromConfig = isIdentityFeatureList(node.config.confirmedFeatures)
        ? node.config.confirmedFeatures.filter((feature) => feature.status === 'confirmed')
        : [];
      const features =
        confirmedIdentity.length > 0
          ? confirmedIdentity
          : fromConfig.length > 0
            ? fromConfig
            : incoming?.kind === 'identity' &&
                incoming.features.every((feature) => feature.status !== 'pending')
              ? incoming.features.filter((feature) => feature.status === 'confirmed')
              : [];
      if (!features.length) {
        const pending = incoming?.kind === 'identity' ? incoming.features : [];
        if (!pending.length) {
          const message = '没有待确认的商品身份候选';
          state.steps.push({ nodeId, title, status: 'failed', message });
          return fail(message);
        }
        state.pausedNodeId = node.id;
        state.steps.push({ nodeId, title, status: 'paused', message: '等待确认商品身份' });
        return {
          status: 'awaiting-confirm',
          gate: 'identity',
          state,
          features: pending,
          summary: pending.map((feature) => feature.statement).join('\n'),
        };
      }
      writePort(state.ports, node.id, 'features', { kind: 'identity', features });
      state.steps.push({ nodeId, title, status: 'ok', message: `已确认 ${features.length} 条身份硬约束` });
      continue;
    }

    if (action === 'prompt') {
      const errMsg = bindPromptNode(graph, node, state.ports);
      if (errMsg) {
        state.steps.push({ nodeId, title, status: 'failed', message: errMsg });
        return fail(errMsg);
      }
      state.steps.push({ nodeId, title, status: 'ok', message: '提示词已绑定到出端口' });
      continue;
    }

    if (action === 'generate') {
      const recipeForGen =
        confirmed ??
        (() => {
          const p = readPort(state.ports, graph, node.id, 'recipe');
          return p?.kind === 'recipe' ? p.recipe : null;
        })();
      // 生成节点通常不直接接 recipe 口；从上游端口包里找已确认配方
      let recipe = recipeForGen;
      if (!recipe?.confirmedAt) {
        for (const value of Object.values(state.ports)) {
          if (value.kind === 'recipe' && value.recipe.confirmedAt) {
            recipe = value.recipe;
            break;
          }
        }
      }
      if (confirmed) recipe = confirmed;

      const res = await generateAndAudit(graph, settings, recipe, runners, node.id, state.ports);
      state.callsUsed += res.callsUsed;
      generation = res;
      if (!res.ok) {
        state.steps.push({ nodeId, title, status: 'failed', message: res.message });
        if (res.imageDataUri) {
          writePort(state.ports, node.id, 'image', {
            kind: 'image',
            dataUri: res.imageDataUri,
            mediaType: res.mediaType ?? 'image/png',
            images: res.images,
          });
        }
        return fail(res.message);
      }
      writePort(state.ports, node.id, 'image', {
        kind: 'image',
        dataUri: res.imageDataUri,
        mediaType: res.mediaType,
        images: res.images,
      });
      if (res.audit) writePort(state.ports, node.id, 'audit', { kind: 'audit', audit: res.audit });
      state.steps.push({
        nodeId,
        title,
        status: 'ok',
        message: res.audit ? `已生成 · ${res.audit.status}` : res.auditSkippedReason ?? '已生成',
      });
      continue;
    }

    if (action === 'audit') {
      if (generation?.ok && generation.audit) {
        state.steps.push({ nodeId, title, status: 'skipped', message: '生成步骤已验收' });
        writePort(state.ports, node.id, 'final', {
          kind: 'image',
          dataUri: generation.imageDataUri,
          mediaType: generation.mediaType,
        });
        continue;
      }
      const imagePort = readPort(state.ports, graph, node.id, 'image');
      if (!imagePort || imagePort.kind !== 'image') {
        state.steps.push({ nodeId, title, status: 'skipped', message: '还没有入边生成图；若生成节点已验收可忽略' });
        continue;
      }
      const recipe =
        confirmed ??
        (() => {
          for (const value of Object.values(state.ports)) {
            if (value.kind === 'recipe' && value.recipe.confirmedAt) return value.recipe;
          }
          return null;
        })();
      const products = productImagesOf(graph, node, state.ports);
      if (!recipe?.confirmedAt || products.length < 1) {
        state.steps.push({
          nodeId,
          title,
          status: 'skipped',
          message: !recipe?.confirmedAt ? '没有已确认配方，跳过验收' : '没有商品图，跳过验收',
        });
        writePort(state.ports, node.id, 'final', {
          kind: 'image',
          dataUri: imagePort.dataUri,
          mediaType: imagePort.mediaType,
        });
        continue;
      }
      if (!isTextConfigured(settings)) {
        state.steps.push({ nodeId, title, status: 'failed', message: '尚未配置文本模型，不能验收' });
        return fail('尚未配置文本模型，不能验收');
      }
      const candidate: UploadedImage = {
        id: 'generated',
        dataUri: imagePort.dataUri,
        mediaType: imagePort.mediaType,
        name: 'generated.png',
      };
      const purpose = purposeOf(graph, state.ports, node.id);
      const auditRes = await runners.audit(settings, products, candidate, recipe, purpose);
      state.callsUsed += 1;
      if (!auditRes.ok) {
        state.steps.push({ nodeId, title, status: 'failed', message: auditRes.message });
        return fail(auditRes.message);
      }
      writePort(state.ports, node.id, 'audit', { kind: 'audit', audit: auditRes.data });
      writePort(state.ports, node.id, 'final', {
        kind: 'image',
        dataUri: imagePort.dataUri,
        mediaType: imagePort.mediaType,
      });
      if (generation?.ok) {
        generation = { ...generation, audit: auditRes.data, callsUsed: generation.callsUsed + 1 };
      }
      state.steps.push({ nodeId, title, status: 'ok', message: auditRes.data.status });
    }

    if (action === 'repair') {
      const auditPort = readPort(state.ports, graph, node.id, 'audit');
      const promptPort = readPort(state.ports, graph, node.id, 'prompt');
      if (auditPort?.kind !== 'audit') {
        state.steps.push({ nodeId, title, status: 'skipped', message: '没有验收结论，跳过修复' });
        continue;
      }
      if (auditPort.audit.status !== 'failed') {
        state.steps.push({ nodeId, title, status: 'skipped', message: '验收未失败，无需修复' });
        continue;
      }
      if (promptPort?.kind !== 'prompt') {
        const message = '缺少编译后的 Prompt，不能生成修复方案';
        state.steps.push({ nodeId, title, status: 'failed', message });
        return fail(message);
      }
      const currentImage = [...Object.values(state.ports)]
        .reverse()
        .find((value): value is Extract<PortValue, { kind: 'image' }> => value.kind === 'image');
      if (!currentImage) {
        const message = '缺少失败的生成图，不能修复';
        state.steps.push({ nodeId, title, status: 'failed', message });
        return fail(message);
      }
      const boundRecipe =
        confirmed ??
        Object.values(state.ports).find(
          (value): value is Extract<PortValue, { kind: 'recipe' }> =>
            value.kind === 'recipe' && !!value.recipe.confirmedAt,
        )?.recipe ??
        null;
      if (!boundRecipe?.confirmedAt) {
        const message = '缺少已确认配方，不能修复';
        state.steps.push({ nodeId, title, status: 'failed', message });
        return fail(message);
      }
      const identityFeatures = Object.values(state.ports).find(
        (value): value is Extract<PortValue, { kind: 'identity' }> =>
          value.kind === 'identity',
      )?.features ?? confirmedIdentity;
      const compiled =
        promptPort.compiled ??
        {
          ...compilePrompt(boundRecipe, identityFeatures, purposeOf(graph, state.ports, node.id)),
          positivePrompt: promptPort.positive,
          negativePrompt: promptPort.negative,
        };
      const products = graph.nodes
        .filter((item) => item.type === 'productInput')
        .flatMap((item) => readUploadedImages(item.config.images));
      const candidate: UploadedImage = {
        id: 'repair-source',
        dataUri: currentImage.dataUri,
        mediaType: currentImage.mediaType,
        name: 'generated.png',
      };

      if (!options.confirmedRepair) {
        if (!isTextConfigured(settings) || !runners.repair) {
          const message = '尚未配置修复模型或修复适配器';
          state.steps.push({ nodeId, title, status: 'failed', message });
          return fail(message);
        }
        const highRisk = isHighRiskAudit(auditPort.audit.issues);
        const repairResult = await runners.repair(
          settings,
          products,
          candidate,
          auditPort.audit,
          compiled,
          identityFeatures
            .filter((feature) => feature.status === 'confirmed')
            .map((feature) => feature.statement),
          highRisk,
        );
        state.callsUsed += 1;
        if (!repairResult.ok) {
          state.steps.push({ nodeId, title, status: 'failed', message: repairResult.message });
          return fail(repairResult.message);
        }
        writePort(state.ports, node.id, 'patch', {
          kind: 'repair',
          proposal: repairResult.data,
        });
        state.pausedNodeId = node.id;
        state.steps.push({ nodeId, title, status: 'paused', message: '等待确认定向修复方案' });
        return {
          status: 'awaiting-confirm',
          gate: 'repair',
          state,
          proposal: repairResult.data,
          summary: repairResult.data.reason,
        };
      }

      if (!isImageConfigured(settings)) {
        const message = '尚未配置图片生成 Endpoint，不能应用修复';
        state.steps.push({ nodeId, title, status: 'failed', message });
        return fail(message);
      }
      const proposal = options.confirmedRepair;
      const repairedPositive =
        proposal.positivePromptOverride?.trim() || compiled.positivePrompt;
      const repairedNegative = [
        compiled.negativePrompt,
        ...proposal.addedNegative.map((item) => `避免：${item}`),
      ]
        .filter(Boolean)
        .join('；');
      const imageResult = await runners.image(settings, repairedPositive, repairedNegative);
      state.callsUsed += 1;
      if (!imageResult.ok) {
        state.steps.push({ nodeId, title, status: 'failed', message: imageResult.message });
        return fail(imageResult.message);
      }
      const repairedDataUri = `data:${imageResult.mediaType};base64,${imageResult.b64Json}`;
      const repairedCandidate: UploadedImage = {
        id: 'repair-result',
        dataUri: repairedDataUri,
        mediaType: imageResult.mediaType,
        name: 'repaired.png',
      };
      const auditResult = await runners.audit(
        settings,
        products,
        repairedCandidate,
        boundRecipe,
        purposeOf(graph, state.ports, node.id),
      );
      state.callsUsed += 1;
      if (!auditResult.ok) {
        state.steps.push({ nodeId, title, status: 'failed', message: auditResult.message });
        return fail(auditResult.message);
      }
      const generator = graph.nodes.find((item) => GENERATE_TYPES.has(item.type));
      const auditor = graph.nodes.find((item) => item.type === 'resultAuditor');
      if (generator) {
        writePort(state.ports, generator.id, 'image', {
          kind: 'image',
          dataUri: repairedDataUri,
          mediaType: imageResult.mediaType,
        });
      }
      if (auditor) {
        writePort(state.ports, auditor.id, 'audit', {
          kind: 'audit',
          audit: auditResult.data,
        });
      }
      generation = {
        ok: true,
        positivePrompt: repairedPositive,
        negativePrompt: repairedNegative,
        imageDataUri: repairedDataUri,
        mediaType: imageResult.mediaType,
        audit: auditResult.data,
        recipeBound: true,
        callsUsed: 2,
      };
      state.steps.push({
        nodeId,
        title,
        status: 'ok',
        message: `已修复并重新验收 · ${auditResult.data.status}`,
      });
      continue;
    }

    if (action === 'sink') {
      const imagePort =
        readPort(state.ports, graph, node.id, 'image') ??
        readPort(state.ports, graph, node.id, 'images') ??
        (() => {
          for (const value of Object.values(state.ports)) {
            if (value.kind === 'image') return value;
          }
          return undefined;
        })();
      if (imagePort?.kind === 'image') {
        writePort(state.ports, node.id, node.type === 'resultGallery' ? 'images' : 'image', imagePort);
      }
      const auditPort = readPort(state.ports, graph, node.id, 'audit');
      if (auditPort?.kind === 'audit') {
        writePort(state.ports, node.id, 'audit', auditPort);
      }
      state.steps.push({
        nodeId,
        title,
        status: 'ok',
        message: imagePort?.kind === 'image' ? '终稿已接收' : '尚无终稿图',
      });
    }
  }

  return { status: 'done', state, extraction, generation };
}

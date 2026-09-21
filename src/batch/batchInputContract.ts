/**
 * 从已发布工作流图推导批量任务需要的输入合同：
 * 共享槽（整批一份）与按行槽（每个商品一份）。
 */
import type { ExecutionPlan } from '../workflow/graph/executionPlan';
import { connectedProductSource, connectedPromptEditor, isVacantPrompt } from '../workflow/graph/promptText';
import type { WorkflowGraph } from '../workflow/graph/types';

export type BatchInputContract = {
  /** 能否用于批量（无人工闸门、有生成+结果展示、有商品图入口） */
  runnable: boolean;
  reason?: string;
  summary: string;
  shared: {
    referenceImages: boolean;
    purpose: boolean;
    /** 整批提示词：有提示词节点，或直接生成且版本里提示词为空 */
    positivePrompt: boolean;
  };
  perRow: {
    productImages: boolean;
    /** 行级提示词覆盖（直接生成；版本已有正文时可选） */
    promptOverride: boolean;
    generationOverrides: boolean;
  };
  /** 版本快照里已有的提示词，用作共享默认值 */
  defaultPositivePrompt: string;
  defaultPurpose: string;
  estimatedModelCallsPerRow: number;
};

const REF_TYPES = new Set(['referenceAnalyze', 'referenceInput']);
const PRODUCT_NODE_TYPES = new Set(['productImages', 'productInput']);
const GENERATE_TYPES = new Set(['sceneGenerate', 'sceneGenerator']);
const GALLERY_TYPES = new Set(['resultGallery', 'finalSink', 'auditExport']);

export function deriveBatchInputContract(
  graph: WorkflowGraph,
  plan?: ExecutionPlan | null,
): BatchInputContract {
  const hasHumanGate = !!plan?.steps.some((step) => step.kind === 'human-gate');
  const hasGenerate = graph.nodes.some((node) => GENERATE_TYPES.has(node.type));
  const hasGallery = graph.nodes.some((node) => GALLERY_TYPES.has(node.type));
  const refNode = graph.nodes.find((node) => REF_TYPES.has(node.type));
  const promptEditor = graph.nodes.find((node) => node.type === 'promptEditor' || node.type === 'promptCompiler');
  const generate = graph.nodes.find((node) => GENERATE_TYPES.has(node.type));

  const needsSharedRefs = !!refNode;
  const needsSharedPurpose = !!refNode;
  const productSourceOnGenerate = generate ? connectedProductSource(graph, generate.id) : null;
  const needsPerRowProducts =
    graph.nodes.some((node) => PRODUCT_NODE_TYPES.has(node.type)) ||
    (!!generate && !productSourceOnGenerate);

  const connectedPrompt = generate ? connectedPromptEditor(graph, generate.id) : null;
  const versionPrompt = connectedPrompt
    ? String(connectedPrompt.config.positivePrompt ?? '')
    : String(generate?.config.positivePrompt ?? '');
  const versionPromptVacant = isVacantPrompt(versionPrompt);

  // 有提示词编辑节点 → 共享提示词（一批一套风格）
  // 直接生成且版本提示词为空 → 共享提示词必填；已有正文 → 可选行级覆盖
  const needsSharedPrompt = !!promptEditor || (!!generate && !connectedPrompt && versionPromptVacant);
  const allowRowPromptOverride = !!generate && !connectedPrompt && !promptEditor;

  const modelCalls =
    plan?.modelCallCount ??
    graph.nodes.filter((node) => node.type === 'referenceAnalyze' || GENERATE_TYPES.has(node.type)).length;

  let runnable = true;
  let reason: string | undefined;
  if (hasHumanGate) {
    runnable = false;
    reason = '该版本含人工确认闸门，不适合批量自动跑完';
  } else if (!hasGenerate || !hasGallery) {
    runnable = false;
    reason = '批量需要包含「商品场景生成」和「结果展示」';
  } else if (!needsPerRowProducts) {
    runnable = false;
    reason = '该版本没有可按商品注入的商品图入口';
  }

  const parts: string[] = [];
  if (needsSharedRefs) parts.push('共享参考图');
  if (needsSharedPurpose) parts.push('用途');
  if (needsSharedPrompt) parts.push('共享提示词');
  if (needsPerRowProducts) parts.push('每行商品图');
  if (allowRowPromptOverride && !needsSharedPrompt) parts.push('可选提示词覆盖');

  return {
    runnable,
    reason,
    summary: parts.length ? parts.join(' + ') : '无可识别输入',
    shared: {
      referenceImages: needsSharedRefs,
      purpose: needsSharedPurpose,
      positivePrompt: needsSharedPrompt,
    },
    perRow: {
      productImages: needsPerRowProducts,
      promptOverride: allowRowPromptOverride,
      generationOverrides: !!generate,
    },
    defaultPositivePrompt: versionPromptVacant ? '' : versionPrompt.trim(),
    defaultPurpose: String(refNode?.config.purpose ?? '').trim(),
    estimatedModelCallsPerRow: Math.max(1, modelCalls),
  };
}

export function isBatchRunnableVersion(graph: WorkflowGraph, plan?: ExecutionPlan | null): boolean {
  return deriveBatchInputContract(graph, plan).runnable;
}

import type { ModelSettings, UploadedImage } from '../shared/types';
import type { StandardRunners } from './graph/execute';
import {
  runConnectedGraph,
  type GraphRunResult,
  type GraphRunState,
} from './graph/execute';
import type { ExecutionPlan } from './graph/executionPlan';
import type { WorkflowGraph } from './graph/types';

export type ExecutableWorkflowVersion = {
  id: string;
  versionNo: number;
  checksum: string;
  graph: WorkflowGraph;
  plan: ExecutionPlan | null;
};

export type WorkflowBindings = {
  productImages: UploadedImage[];
  referenceImages?: UploadedImage[];
  purpose?: string;
  positivePrompt?: string;
  negativePrompt?: string;
  targetUse?: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  seed?: number;
};

export type WorkflowRuntimeInput = {
  version: ExecutableWorkflowVersion;
  bindings: WorkflowBindings;
  settings: ModelSettings | null;
  resume?: GraphRunState | null;
  runners?: StandardRunners;
};

export type WorkflowRuntimeResult = GraphRunResult & {
  workflowVersionId: string;
  workflowVersionNo: number;
};

/** 运行时绑定只注入已发布图的输入槽，不修改持久化版本。 */
export function bindWorkflowInputs(
  graph: WorkflowGraph,
  bindings: WorkflowBindings,
): WorkflowGraph {
  const cloned = JSON.parse(JSON.stringify(graph)) as WorkflowGraph;

  if (bindings.referenceImages?.length) {
    for (const node of cloned.nodes) {
      if (node.type !== 'referenceAnalyze' && node.type !== 'referenceInput') continue;
      node.config = { ...node.config, images: bindings.referenceImages };
    }
  }
  if (bindings.purpose !== undefined) {
    const purpose = String(bindings.purpose).trim();
    if (purpose) {
      for (const node of cloned.nodes) {
        if (node.type !== 'referenceAnalyze' && node.type !== 'referenceInput') continue;
        node.config = { ...node.config, purpose };
      }
    }
  }

  const productNode = cloned.nodes.find((node) => node.type === 'productImages');
  const wiredToProduct =
    !!productNode &&
    cloned.edges.some((edge) => edge.from.node === productNode.id && edge.to.port === 'products');
  if (wiredToProduct && productNode) {
    productNode.config = { ...productNode.config, images: bindings.productImages };
  }

  if (bindings.positivePrompt !== undefined) {
    const prompt = String(bindings.positivePrompt);
    for (const node of cloned.nodes) {
      if (node.type === 'promptEditor' || node.type === 'promptCompiler') {
        node.config = {
          ...node.config,
          positivePrompt: prompt,
          ...(prompt.trim() ? { promptEditedByUser: true } : {}),
        };
      }
    }
  }

  for (const node of cloned.nodes) {
    if (node.type !== 'sceneGenerate' && node.type !== 'sceneGenerator') continue;
    const hasPromptEdge = cloned.edges.some(
      (edge) => edge.to.node === node.id && edge.to.port === 'prompt',
    );
    node.config = {
      ...node.config,
      ...(wiredToProduct ? {} : { productImages: bindings.productImages }),
      ...(bindings.positivePrompt !== undefined && !hasPromptEdge
        ? { positivePrompt: bindings.positivePrompt }
        : {}),
      ...(bindings.negativePrompt !== undefined
        ? { negativePrompt: bindings.negativePrompt }
        : {}),
      ...(bindings.targetUse ? { targetUse: bindings.targetUse } : {}),
      ...(bindings.aspectRatio ? { aspectRatio: bindings.aspectRatio } : {}),
      ...(bindings.resolution ? { resolution: bindings.resolution } : {}),
      ...(bindings.count ? { count: bindings.count } : {}),
      ...(bindings.seed !== undefined ? { seed: bindings.seed } : {}),
    };
  }
  return cloned;
}

export async function runWorkflowVersion(
  input: WorkflowRuntimeInput,
): Promise<WorkflowRuntimeResult> {
  if (!input.version.plan) {
    throw new Error('工作流版本没有可执行计划，请重新发布');
  }
  const graph = bindWorkflowInputs(input.version.graph, input.bindings);
  const result = await runConnectedGraph(graph, input.settings, {
    resume: input.resume,
    runners: input.runners,
  });
  return {
    ...result,
    workflowVersionId: input.version.id,
    workflowVersionNo: input.version.versionNo,
  };
}

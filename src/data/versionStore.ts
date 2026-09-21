/**
 * 工作流版本（docs/15 §3.4/§8）。
 * 发布 = 草稿深拷贝 + 固化校验/计划信息 + 内容校验和，生成不可变版本。
 * 批量任务只能引用已发布版本；发布后再编辑产生新版本，不影响历史运行。
 */
import { openKey, STORE_WORKFLOW_VERSIONS, type SaveStatus } from './db';
import { validateGraph } from '../workflow/graph/validate';
import {
  compileExecutionPlan,
  executionCapabilityIssues,
  type ExecutionPlan,
} from '../workflow/graph/executionPlan';
import type { WorkflowGraph, GraphValidationResult } from '../workflow/graph/types';

export type WorkflowVersion = {
  id: string; // wfv_<project>_v<n>
  projectId: string;
  versionNo: number;
  name: string;
  graph: WorkflowGraph; // 发布瞬间的不可变快照
  /** 发布时固化；旧版本读取时按其不可变 graph 在内存中补齐。 */
  plan: ExecutionPlan | null;
  checksum: string;
  validation: GraphValidationResult;
  createdAt: string;
  note?: string;
};

type VersionIndex = { versions: string[]; latest: number };

function indexKey(projectId: string) {
  return `vers:${projectId}`;
}
function versionDocKey(projectId: string, no: number) {
  return `ver:${projectId}:v${no}`;
}

async function loadIndex(projectId: string): Promise<VersionIndex> {
  const key = openKey<VersionIndex>(STORE_WORKFLOW_VERSIONS, indexKey(projectId));
  const raw = await key.load((d) => d as VersionIndex);
  return raw && Array.isArray(raw.versions) ? raw : { versions: [], latest: 0 };
}

/** 非加密内容哈希（FNV-1a），用于判断版本内容是否变化 */
export function checksumGraph(graph: WorkflowGraph): string {
  const canonical = JSON.stringify({
    nodes: [...graph.nodes]
      .map((n) => ({ t: n.type, p: n.position, c: n.config }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    edges: [...graph.edges]
      .map((e) => `${e.from.node}.${e.from.port}->${e.to.node}.${e.to.port}`)
      .sort(),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a-${h.toString(16).padStart(8, '0')}`;
}

export class PublishBlockedError extends Error {
  validation: GraphValidationResult;
  constructor(validation: GraphValidationResult) {
    super(`存在 ${validation.errors.length} 个校验错误，无法发布`);
    this.validation = validation;
  }
}

export async function listVersions(projectId: string): Promise<WorkflowVersion[]> {
  const idx = await loadIndex(projectId);
  const all: WorkflowVersion[] = [];
  for (const docKey of idx.versions) {
    const key = openKey<WorkflowVersion>(STORE_WORKFLOW_VERSIONS, docKey);
    const v = await key.load((d) => d as WorkflowVersion);
    if (v) {
      // v5 以前的版本没有 plan。只做内存兼容，不改写历史文档。
      const legacy = v as WorkflowVersion & { plan?: ExecutionPlan | null };
      if (!legacy.plan) {
        try {
          legacy.plan = compileExecutionPlan(legacy.graph);
        } catch {
          // 旧版本可能含现在已下线的节点；仍允许只读列出，但不可运行。
          legacy.plan = null;
        }
      }
      all.push(legacy);
    }
  }
  return all.sort((a, b) => b.versionNo - a.versionNo);
}

export type PublishInput = {
  projectId: string;
  name: string;
  graph: WorkflowGraph;
  note?: string;
};

/**
 * 发布前检查 + 创建不可变版本。
 * 任何结构错误或缺失适配器都阻断，发布结果固化为确定执行计划。
 */
export async function publishVersion(input: PublishInput): Promise<WorkflowVersion> {
  const validation = validateGraph(input.graph);
  validation.errors.push(...executionCapabilityIssues(input.graph));
  validation.canPublish = validation.errors.length === 0;
  if (validation.errors.length) throw new PublishBlockedError(validation);
  const plan = compileExecutionPlan(input.graph);

  const idx = await loadIndex(input.projectId);
  const versionNo = idx.latest + 1;
  const version: WorkflowVersion = {
    id: `wfv_${input.projectId}_v${versionNo}`,
    projectId: input.projectId,
    versionNo,
    name: input.name,
    graph: JSON.parse(JSON.stringify(input.graph)) as WorkflowGraph,
    plan,
    checksum: checksumGraph(input.graph),
    validation,
    createdAt: new Date().toISOString(),
    note: input.note,
  };

  const docKey = versionDocKey(input.projectId, versionNo);
  const vKey = openKey<WorkflowVersion>(STORE_WORKFLOW_VERSIONS, docKey);
  await vKey.enqueue(version);

  const nextIndex: VersionIndex = {
    versions: [...idx.versions, docKey],
    latest: versionNo,
  };
  const iKey = openKey<VersionIndex>(STORE_WORKFLOW_VERSIONS, indexKey(input.projectId));
  const status: SaveStatus = await iKey.enqueue(nextIndex);
  if (status === 'failed') throw new Error('版本索引保存失败');

  return version;
}

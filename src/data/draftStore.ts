/**
 * 工作流草稿持久化（docs/11 附录 A · 本阶段先落 drafts，不做发布版本）。
 * 复用 db 的 PersistedKey 串行写保护；图本身为应用层保证形状的数据，读取做最小结构校验。
 */
import { openKey, STORE_WORKFLOW_DRAFTS, type SaveStatus } from './db';
import { getTemplate } from '../workflow/graph/templates';
import type { WorkflowDraft, WorkflowGraph } from '../workflow/graph/types';

function draftKey(projectId: string): string {
  return `draft:${projectId}`;
}

function isGraph(x: unknown): x is WorkflowGraph {
  return (
    !!x &&
    typeof x === 'object' &&
    Array.isArray((x as WorkflowGraph).nodes) &&
    Array.isArray((x as WorkflowGraph).edges)
  );
}

/**
 * 读取项目草稿；不存在时按模板生成（不落盘，等首次编辑保存）。
 * @param templateId 模板 id（默认标准静物模板）
 */
export async function loadDraft(
  projectId: string,
  name: string,
  templateId = 'standard-still-life',
): Promise<WorkflowDraft> {
  const key = openKey<WorkflowDraft>(STORE_WORKFLOW_DRAFTS, draftKey(projectId));
  const stored = await key.load((d) => d as WorkflowDraft);
  if (stored && isGraph(stored.graph)) return stored;
  const tpl = getTemplate(templateId);
  const now = new Date().toISOString();
  return {
    id: `wfd_${projectId}`,
    projectId,
    name,
    basedOnTemplateId: tpl.id,
    graph: tpl.buildGraph(),
    publishedVersionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建新项目草稿（显式选定模板）。深拷贝模板，后续编辑不影响模板源。 */
export function createDraftFromTemplate(
  projectId: string,
  name: string,
  templateId: string,
): WorkflowDraft {
  const tpl = getTemplate(templateId);
  const now = new Date().toISOString();
  return {
    id: `wfd_${projectId}`,
    projectId,
    name,
    basedOnTemplateId: tpl.id,
    graph: tpl.buildGraph(),
    publishedVersionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function persistDraft(draft: WorkflowDraft): Promise<SaveStatus> {
  const key = openKey<WorkflowDraft>(STORE_WORKFLOW_DRAFTS, draftKey(draft.projectId));
  return key.enqueue({ ...draft, updatedAt: new Date().toISOString() });
}

/** 保存草稿（图可以带校验错误） */
export function saveDraft(draft: WorkflowDraft): Promise<SaveStatus> {
  return persistDraft(draft);
}

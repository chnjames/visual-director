/**
 * 项目集合（docs/11 §4.1、docs/03 项目为顶层对象）。
 * 单个 IndexedDB 文档保存全部项目元数据；业务文档（工作流/批次/画布视图）
 * 分别按项目 key 存放。API Key 绝不进入项目文档。
 */
import { projectsKey, deleteProjectDocs, type SaveStatus } from './db';
import {
  normalizeGenerationDefaults,
  type GenerationDefaults,
} from '../workflow/generationOptions';

export type ProjectStatus =
  | 'draft' // 尚未确认配方
  | 'recipe-ready' // 配方已确认，工作流可运行
  | 'running' // 存在进行中/待确认任务
  | 'completed' // 已有通过结果
  | 'sample'; // 只读真实案例

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: ProjectStatus;
  /** 封面素材 ID（取最新一张 generated 素材的 asset id），无封面时由首页渲染明确占位 */
  coverAssetId?: string;
  /** 生成结果数量 */
  generatedCount: number;
  /** 待人工确认数量 */
  awaitingReviewCount: number;
  /** 项目用途/备注（建项时可选） */
  note?: string;
  /** 创建时所选工作流模板 id */
  templateId?: string;
  /** 只读样例项目：禁用一切写操作与真实运行 */
  readonlySample?: boolean;
  /** 新加入的商品场景生成节点使用的默认用途/比例/分辨率/数量 */
  generationDefaults?: GenerationDefaults;
};

export type ProjectSort = 'recent' | 'name' | 'created';
export type ProjectStatusFilter = 'all' | ProjectStatus;

function now(): string {
  return new Date().toISOString();
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(raw: unknown): Project[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      id: String(p.id ?? ''),
      name: String(p.name ?? '未命名项目'),
      createdAt: String(p.createdAt ?? now()),
      updatedAt: String(p.updatedAt ?? now()),
      status: (['draft', 'recipe-ready', 'running', 'completed', 'sample'].includes(
        String(p.status),
      )
        ? String(p.status)
        : 'draft') as ProjectStatus,
      coverAssetId:
        typeof p.coverAssetId === 'string' && p.coverAssetId ? p.coverAssetId : undefined,
      generatedCount: Number.isFinite(p.generatedCount) ? Number(p.generatedCount) : 0,
      awaitingReviewCount: Number.isFinite(p.awaitingReviewCount)
        ? Number(p.awaitingReviewCount)
        : 0,
      note: typeof p.note === 'string' && p.note ? p.note : undefined,
      templateId: typeof p.templateId === 'string' && p.templateId ? p.templateId : undefined,
      readonlySample: p.readonlySample === true,
      generationDefaults: p.generationDefaults
        ? normalizeGenerationDefaults(p.generationDefaults)
        : undefined,
    }))
    .filter((p) => p.id.length > 0);
}

export async function listProjects(): Promise<Project[]> {
  const key = projectsKey();
  const raw = await key.load((d) => d as unknown[]);
  return normalize(raw ?? []);
}

async function persist(projects: Project[]): Promise<SaveStatus> {
  return projectsKey().enqueue(projects as unknown);
}

export async function createProject(name: string, note?: string, templateId?: string): Promise<Project> {
  const projects = await listProjects();
  const ts = now();
  const project: Project = {
    id: uid('proj'),
    name: name.trim() || `静物视觉项目 ${projects.length + 1}`,
    note: note?.trim() || undefined,
    templateId: templateId || undefined,
    createdAt: ts,
    updatedAt: ts,
    status: 'draft',
    generatedCount: 0,
    awaitingReviewCount: 0,
  };
  await persist([project, ...projects]);
  return project;
}

/** 供 DB v3 迁移调用：确保存在指定 id 的迁移项目（幂等） */
export async function ensureMigrationProject(id: string): Promise<void> {
  const projects = await listProjects();
  if (projects.some((p) => p.id === id)) return;
  const ts = now();
  projects.unshift({
    id,
    name: '迁移自旧版的工作',
    createdAt: ts,
    updatedAt: ts,
    status: 'draft',
    generatedCount: 0,
    awaitingReviewCount: 0,
  });
  await persist(projects);
}

export async function renameProject(id: string, name: string): Promise<Project | null> {
  return updateProject(id, { name });
}

export async function updateProject(
  id: string,
  patch: Partial<
    Pick<
      Project,
      | 'status'
      | 'generatedCount'
      | 'awaitingReviewCount'
      | 'coverAssetId'
      | 'updatedAt'
      | 'name'
      | 'note'
      | 'generationDefaults'
    >
  >,
): Promise<Project | null> {
  const projects = await listProjects();
  if (!projects.some((p) => p.id === id)) return null;
  const next = projects.map((p) => {
    if (p.id !== id) return p;
    return {
      ...p,
      ...patch,
      name: patch.name !== undefined ? patch.name.trim() || p.name : p.name,
      note: patch.note !== undefined ? patch.note.trim() || undefined : p.note,
      generationDefaults:
        patch.generationDefaults !== undefined
          ? normalizeGenerationDefaults(patch.generationDefaults)
          : p.generationDefaults,
      updatedAt: patch.updatedAt ?? now(),
    };
  });
  await persist(next);
  return next.find((p) => p.id === id) ?? null;
}

export async function deleteProject(id: string): Promise<void> {
  const projects = await listProjects();
  await persist(projects.filter((p) => p.id !== id));
  await deleteProjectDocs(id);
}

/* ----------------------------- 前端派生 ----------------------------- */

export function filterAndSortProjects(
  projects: Project[],
  query: string,
  status: ProjectStatusFilter,
  sort: ProjectSort,
): Project[] {
  const q = query.trim().toLowerCase();
  const filtered = projects.filter((p) => {
    if (status !== 'all' && p.status !== status) return false;
    if (q && !`${p.name} ${p.note ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const byTime = (a: Project, b: Project) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (sort === 'name') {
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }
  if (sort === 'created') {
    return [...filtered].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
  return [...filtered].sort(byTime);
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: '配置中',
  'recipe-ready': '待运行',
  running: '运行中',
  completed: '已出图',
  sample: '只读案例',
};

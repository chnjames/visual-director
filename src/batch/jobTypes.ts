import type { UploadedImage } from '../shared/types';

export type BatchJobStatus = 'draft' | 'running' | 'paused' | 'completed';
export type BatchRowStatus =
  | 'pending'
  | 'running'
  | 'waiting-user'
  | 'done'
  | 'failed'
  | 'skipped';

export type BatchRowOverrides = {
  targetUse?: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  /** 直接生成：可选覆盖版本/共享提示词 */
  positivePrompt?: string;
};

/** 整批共享输入（由所选工作流版本的输入合同决定哪些生效） */
export type BatchSharedInputs = {
  referenceImages: UploadedImage[];
  purpose: string;
  positivePrompt: string;
};

export type BatchJobRow = {
  id: string;
  name: string;
  productImages: UploadedImage[];
  overrides: BatchRowOverrides;
  status: BatchRowStatus;
  currentStep?: string;
  runId?: string;
  resultCount: number;
  error?: string;
  retryCount: number;
};

export type BatchJob = {
  schemaVersion: 3;
  id: string;
  projectId: string;
  workflowVersionId: string | null;
  workflowVersionNo?: number;
  status: BatchJobStatus;
  shared: BatchSharedInputs;
  rows: BatchJobRow[];
  createdAt: string;
  updatedAt: string;
};

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptySharedInputs(): BatchSharedInputs {
  return { referenceImages: [], purpose: '', positivePrompt: '' };
}

export function createBatchJob(projectId: string): BatchJob {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    id: uid('batch'),
    projectId,
    workflowVersionId: null,
    status: 'draft',
    shared: emptySharedInputs(),
    rows: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createBatchRow(index: number): BatchJobRow {
  return {
    id: uid('row'),
    name: `商品 ${index + 1}`,
    productImages: [],
    overrides: {},
    status: 'pending',
    resultCount: 0,
    retryCount: 0,
  };
}

/** 兼容 schemaVersion 2（无 shared）读入为 v3 */
export function normalizeBatchJob(raw: unknown, projectId: string): BatchJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const job = raw as {
    schemaVersion?: number;
    id?: string;
    projectId?: string;
    workflowVersionId?: string | null;
    workflowVersionNo?: number;
    status?: BatchJobStatus;
    shared?: Partial<BatchSharedInputs>;
    rows?: BatchJobRow[];
    createdAt?: string;
    updatedAt?: string;
  };
  if (job.schemaVersion !== 2 && job.schemaVersion !== 3) return null;
  if (!Array.isArray(job.rows)) return null;
  return {
    schemaVersion: 3,
    id: typeof job.id === 'string' ? job.id : uid('batch'),
    projectId: typeof job.projectId === 'string' ? job.projectId : projectId,
    workflowVersionId: job.workflowVersionId ?? null,
    workflowVersionNo: job.workflowVersionNo,
    status:
      job.status === 'running' || job.status === 'paused' || job.status === 'completed'
        ? job.status
        : 'draft',
    shared: {
      referenceImages: Array.isArray(job.shared?.referenceImages) ? job.shared.referenceImages : [],
      purpose: typeof job.shared?.purpose === 'string' ? job.shared.purpose : '',
      positivePrompt: typeof job.shared?.positivePrompt === 'string' ? job.shared.positivePrompt : '',
    },
    rows: job.rows,
    createdAt: typeof job.createdAt === 'string' ? job.createdAt : new Date().toISOString(),
    updatedAt: typeof job.updatedAt === 'string' ? job.updatedAt : new Date().toISOString(),
  };
}

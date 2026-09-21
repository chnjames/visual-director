/**
 * 本地持久化（IndexedDB，无环境时退化内存）。
 *
 * DB v3 存储规划：
 * - workflows：单件工作流（旧单例 current-single-item + 项目级 wf:<projectId>）
 * - batch：批量文档（旧单例 current-batch + 项目级 batch:<projectId>）
 * - projects：项目集合（单文档 list:projects）
 * - canvasView：每项目画布视口/节点位置（view:<projectId>）
 *
 * 写入安全（v2 起）：
 * - PersistedKey：per-key 串行写链 + 单调序号，杜绝异步 put 乱序覆盖；
 * - 包装格式 {__persistVersion, seq, data}；旧裸文档读取透传、下次保存自动升级。
 *
 * API Key 绝不进入任何 store（只允许 sessionStorage）。
 */
import { parsePersistedWorkflow } from '../workflow/workflowSchema';
import { parsePersistedBatch } from '../batch/batchSchema';
import type { SingleItemWorkflow } from '../workflow/workflowTypes';
import type { Batch } from '../batch/batchTypes';

const DB_NAME = 'visual-recipe-factory';
const DB_VERSION = 5;
export const STORE_WORKFLOWS = 'workflows';
export const STORE_BATCH = 'batch';
export const STORE_PROJECTS = 'projects';
export const STORE_CANVAS_VIEW = 'canvasView';
/** v4：自定义工作流草稿（每个项目一份） */
export const STORE_WORKFLOW_DRAFTS = 'workflowDrafts';
/** v4：不可变工作流版本（文档 + 每项目索引） */
export const STORE_WORKFLOW_VERSIONS = 'workflowVersions';
/** v5：画布试运行记录（文档 + 每项目索引） */
export const STORE_RUNS = 'runs';
/** v5：项目素材清单（参考图/商品图/生成图） */
export const STORE_ASSETS = 'assets';

export const CURRENT_KEY = 'current-single-item';
export const BATCH_KEY = 'current-batch';
const PROJECTS_KEY = 'list:projects';
const MIGRATION_KEY = 'v3:migrated-default-project';

/** 持久化包装格式版本（与业务 schemaVersion 无关） */
const PERSIST_WRAPPER_VERSION = 1;

export type SaveStatus = 'idb' | 'memory' | 'failed';

let memoryStore: Record<string, unknown> = {};

function idbAvailable(): IDBFactory | null {
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB;
  } catch {
    /* ignore */
  }
  return null;
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [
        STORE_WORKFLOWS,
        STORE_BATCH,
        STORE_PROJECTS,
        STORE_CANVAS_VIEW,
        STORE_WORKFLOW_DRAFTS,
        STORE_WORKFLOW_VERSIONS,
        STORE_RUNS,
        STORE_ASSETS,
      ]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

function txn<T>(
  idb: IDBFactory,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb(idb).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        req.onsuccess = () => {
          resolve(req.result);
          db.close();
        };
        req.onerror = () => {
          reject(req.error ?? new Error('IndexedDB 操作失败'));
          db.close();
        };
      }),
  );
}

/* ------------------------------------------------------------------ */
/* 通用串行写队列：per-key 链式执行 + 单调序号防旧写覆盖新写            */
/* ------------------------------------------------------------------ */

type Wrapper<T> = { __persistVersion: 1; seq: number; data: T };

function isWrapper(raw: unknown): raw is Wrapper<unknown> {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as { __persistVersion?: unknown }).__persistVersion === PERSIST_WRAPPER_VERSION
  );
}

/** 包装文档序号；裸旧文档视为 0；空视为 -1。 */
function wrapperSeq(raw: unknown): number {
  if (raw == null) return -1;
  if (isWrapper(raw) && Number.isInteger(raw.seq)) return raw.seq;
  return 0;
}

/**
 * 在 IDB 主存与内存兜底之间取更新的一份。
 * 写入 IDB 失败后只进了 memory 时，下一次 load 必须仍能读到，不能被空的 IDB 冲掉。
 */
function pickNewer(primary: unknown, memory: unknown): unknown {
  const sp = wrapperSeq(primary);
  const sm = wrapperSeq(memory);
  if (sm > sp) return memory;
  if (sp > sm) return primary;
  return primary ?? memory ?? null;
}

export type KeyIO = {
  read: () => Promise<unknown>;
  write: (wrapped: Wrapper<unknown>) => Promise<SaveStatus>;
  remove: () => Promise<void>;
  memoryRead: () => unknown;
  memoryWrite: (wrapped: Wrapper<unknown>) => void;
  memoryRemove: () => void;
};

/** 内存兜底键命名空间，避免不同 store 同名 key 冲突 */
function memKey(store: string, key: string): string {
  return `${store}::${key}`;
}

/**
 * 单个持久化 key 的写入控制器（纯逻辑，IO 可注入以便单测）。
 * 保证：enqueue 的写入严格按入队顺序落盘；序号回退的过期写入被丢弃。
 */
export class PersistedKey<T> {
  private chain: Promise<unknown> = Promise.resolve();
  /** 已完成落盘的最大序号 */
  private seq = 0;
  /** 入队计数器：入队即递增，保证连发的写入拿到严格递增的身份 */
  private enqueueSeq = 0;
  private hydrated = false;
  /** 本会话链上最后一次确认的值；供 enqueueMutate 避免并发读旧快照 */
  private lastData: T | null | undefined = undefined;

  constructor(private readonly io: KeyIO) {}

  async load(parse: (data: unknown) => T): Promise<T | null> {
    let primary: unknown = null;
    try {
      primary = await this.io.read();
    } catch {
      primary = null;
    }
    const raw = pickNewer(primary, this.io.memoryRead());
    if (raw == null) {
      this.hydrated = true;
      this.lastData = null;
      return null;
    }
    let data: unknown = raw;
    if (isWrapper(raw)) {
      if (Number.isInteger(raw.seq) && raw.seq > this.seq) {
        this.seq = raw.seq;
        this.enqueueSeq = Math.max(this.enqueueSeq, raw.seq);
      }
      data = raw.data;
    }
    try {
      const parsed = parse(data);
      this.hydrated = true;
      this.lastData = parsed;
      return parsed;
    } catch {
      this.hydrated = true;
      this.lastData = null;
      return null;
    }
  }

  enqueue(value: T): Promise<SaveStatus> {
    this.enqueueSeq += 1;
    const gen = this.enqueueSeq;
    const run = async (): Promise<SaveStatus> => {
      if (gen <= this.seq) return 'failed';
      const wrapped: Wrapper<T> = { __persistVersion: PERSIST_WRAPPER_VERSION, seq: gen, data: value };
      try {
        const status = await this.io.write(wrapped);
        // 始终镜像到 memory，保证失败兜底与同会话 load 能按 seq 取到最新值
        this.io.memoryWrite(wrapped);
        this.seq = gen;
        this.lastData = value;
        this.hydrated = true;
        return status;
      } catch {
        this.io.memoryWrite(wrapped);
        this.seq = gen;
        this.lastData = value;
        this.hydrated = true;
        return 'failed';
      }
    };
    const result: Promise<SaveStatus> = this.chain.then(run, run);
    this.chain = result;
    return result;
  }

  /**
   * 在串行链内读-改-写，避免并发 upsert 用过期快照互相覆盖。
   * updater 返回 null 表示放弃写入（例如重复素材）。
   */
  enqueueMutate(updater: (prev: T | null) => T | null): Promise<{ status: SaveStatus; value: T | null }> {
    this.enqueueSeq += 1;
    const gen = this.enqueueSeq;
    const run = async (): Promise<{ status: SaveStatus; value: T | null }> => {
      if (gen <= this.seq) return { status: 'failed', value: null };
      const prev = await this.readLatest();
      const next = updater(prev);
      if (next == null) return { status: 'idb', value: prev };
      const wrapped: Wrapper<T> = { __persistVersion: PERSIST_WRAPPER_VERSION, seq: gen, data: next };
      try {
        const status = await this.io.write(wrapped);
        this.io.memoryWrite(wrapped);
        this.seq = gen;
        this.lastData = next;
        this.hydrated = true;
        return { status, value: next };
      } catch {
        this.io.memoryWrite(wrapped);
        this.seq = gen;
        this.lastData = next;
        this.hydrated = true;
        return { status: 'failed', value: next };
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readLatest(): Promise<T | null> {
    if (this.lastData !== undefined) return this.lastData;
    let primary: unknown = null;
    try {
      primary = await this.io.read();
    } catch {
      primary = null;
    }
    const raw = pickNewer(primary, this.io.memoryRead());
    if (raw == null) {
      this.lastData = null;
      return null;
    }
    if (isWrapper(raw)) {
      if (Number.isInteger(raw.seq) && raw.seq > this.seq) {
        this.seq = raw.seq;
        this.enqueueSeq = Math.max(this.enqueueSeq, raw.seq);
      }
      this.lastData = raw.data as T;
      return this.lastData;
    }
    this.lastData = raw as T;
    return this.lastData;
  }

  enqueueClear(): Promise<void> {
    this.enqueueSeq += 1;
    const gen = this.enqueueSeq;
    const run = async (): Promise<void> => {
      this.io.memoryRemove();
      try {
        await this.io.remove();
      } catch {
        /* ignore */
      }
      this.seq = gen;
      this.lastData = null;
    };
    const result: Promise<void> = this.chain.then(run, run);
    this.chain = result;
    return result;
  }

  isHydrated(): boolean {
    return this.seq >= 0 && this.hydrated;
  }
}

/* ------------------------------------------------------------------ */
/* 通用 key 工厂（按 store + 文档 key 惰性创建，各自独立串行链）         */
/* ------------------------------------------------------------------ */

const keyRegistry = new Map<string, PersistedKey<unknown>>();

/**
 * 打开一个持久化文档句柄。
 * 形状校验在 load(parse) 时由调用方提供：
 * 业务文档（wf/batch）传入 zod 形状校验；projects/canvasView 由应用层保证形状。
 */
export function openKey<T>(storeName: string, docKey: string): PersistedKey<T> {
  const registryKey = `${storeName}/${docKey}`;
  const existing = keyRegistry.get(registryKey);
  if (existing) return existing as PersistedKey<T>;
  const key = new PersistedKey<T>({
    read: () => {
      const idb = idbAvailable();
      if (!idb) return Promise.resolve(memoryStore[memKey(storeName, docKey)] ?? null);
      return txn(idb, storeName, 'readonly', (store) => store.get(docKey));
    },
    write: async (wrapped) => {
      const idb = idbAvailable();
      if (!idb) return 'memory' satisfies SaveStatus;
      await txn(idb, storeName, 'readwrite', (store) => store.put(wrapped, docKey));
      return 'idb' satisfies SaveStatus;
    },
    remove: () => {
      delete memoryStore[memKey(storeName, docKey)];
      const idb = idbAvailable();
      if (!idb) return Promise.resolve();
      return txn(idb, storeName, 'readwrite', (store) => store.delete(docKey));
    },
    memoryRead: () => memoryStore[memKey(storeName, docKey)],
    memoryWrite: (wrapped) => {
      memoryStore[memKey(storeName, docKey)] = wrapped;
    },
    memoryRemove: () => {
      delete memoryStore[memKey(storeName, docKey)];
    },
  });
  keyRegistry.set(registryKey, key as PersistedKey<unknown>);
  return key;
}

/* ------------------------------------------------------------------ */
/* 单件工作流（支持项目级 key；无 projectId 时为旧单例，保持兼容）       */
/* ------------------------------------------------------------------ */

export function workflowDocKey(projectId?: string): string {
  return projectId ? `wf:${projectId}` : CURRENT_KEY;
}

export function saveWorkflow(wf: SingleItemWorkflow, projectId?: string): Promise<SaveStatus> {
  return openKey<SingleItemWorkflow>(STORE_WORKFLOWS, workflowDocKey(projectId)).enqueue(wf);
}

export async function loadWorkflow(projectId?: string): Promise<SingleItemWorkflow | null> {
  const key = openKey<SingleItemWorkflow>(STORE_WORKFLOWS, workflowDocKey(projectId));
  return key.load((raw) => parsePersistedWorkflow(raw) as unknown as SingleItemWorkflow);
}

export function clearWorkflow(projectId?: string): Promise<void> {
  return openKey<SingleItemWorkflow>(STORE_WORKFLOWS, workflowDocKey(projectId)).enqueueClear();
}

/* ------------------------------------------------------------------ */
/* 批量（同上，支持项目级 key）                                          */
/* ------------------------------------------------------------------ */

export function batchDocKey(projectId?: string): string {
  return projectId ? `batch:${projectId}` : BATCH_KEY;
}

export function saveBatch(batch: Batch, projectId?: string): Promise<SaveStatus> {
  return openKey<Batch>(STORE_BATCH, batchDocKey(projectId)).enqueue(batch);
}

export async function loadBatch(projectId?: string): Promise<Batch | null> {
  const key = openKey<Batch>(STORE_BATCH, batchDocKey(projectId));
  return key.load((raw) => parsePersistedBatch(raw));
}

export function clearBatch(projectId?: string): Promise<void> {
  return openKey<Batch>(STORE_BATCH, batchDocKey(projectId)).enqueueClear();
}

/* ------------------------------------------------------------------ */
/* DB v3 迁移：旧单例文档迁入“迁移项目”，保证用户当前工作不丢失         */
/* ------------------------------------------------------------------ */

export type MigrationResult = {
  migratedProjectId: string | null;
  hadWorkflow: boolean;
  hadBatch: boolean;
};

/**
 * 幂等迁移：
 * - projects 集合尚不存在默认迁移项目、且旧单例中存在工作流/批次时，
 *   创建一个“迁移项目”，把旧文档复制为项目级文档（不删除旧文档）。
 * - 迁移标记与项目集合一起持久化；无 IndexedDB（测试/隐私模式）时为内存 no-op。
 */
export async function migrateLegacyDocs(createProjectRecord: (id: string) => Promise<void>): Promise<MigrationResult> {
  const result: MigrationResult = { migratedProjectId: null, hadWorkflow: false, hadBatch: false };
  const legacyWf = await loadWorkflow();
  const legacyBatch = await loadBatch();
  if (!legacyWf && !legacyBatch) return result;

  const migrationKey = openKey<{ done: boolean; projectId: string }>(
    STORE_PROJECTS,
    MIGRATION_KEY,
  );
  const marker = await migrationKey.load((d) => d as { done: boolean; projectId: string });
  if (marker?.done) {
    result.migratedProjectId = marker.projectId;
    result.hadWorkflow = !!legacyWf;
    result.hadBatch = !!legacyBatch;
    return result;
  }

  const projectId = 'migrated-project';
  await createProjectRecord(projectId);
  if (legacyWf) {
    await saveWorkflow(legacyWf, projectId);
    result.hadWorkflow = true;
  }
  if (legacyBatch) {
    await saveBatch(legacyBatch, projectId);
    result.hadBatch = true;
  }
  await migrationKey.enqueue({ done: true, projectId });
  result.migratedProjectId = projectId;
  return result;
}

/* ------------------------------------------------------------------ */
/* 通用文档（projects 集合、canvasView）                                */
/* ------------------------------------------------------------------ */

export function projectsKey() {
  return openKey<unknown>(STORE_PROJECTS, PROJECTS_KEY);
}

export function canvasViewKey(projectId: string) {
  return openKey<unknown>(STORE_CANVAS_VIEW, `view:${projectId}`);
}

/** 删除项目时级联清理其全部文档 */
export async function deleteProjectDocs(projectId: string): Promise<void> {
  await clearWorkflow(projectId);
  await clearBatch(projectId);
  await openKey(STORE_BATCH, `batch-v2:${projectId}`).enqueueClear();
  await openKey(STORE_CANVAS_VIEW, `view:${projectId}`).enqueueClear();
  await openKey(STORE_WORKFLOW_DRAFTS, `draft:${projectId}`).enqueueClear();
  await openKey(STORE_ASSETS, `assets:${projectId}`).enqueueClear();
  // runs：清索引；单条 run 文档会随索引丢失而成为孤儿，下次 list 忽略
  const runIdx = openKey<{ ids: string[] }>(STORE_RUNS, `runs:${projectId}`);
  const idx = await runIdx.load((d) => d as { ids: string[] });
  if (idx?.ids?.length) {
    for (const id of idx.ids) {
      await openKey(STORE_RUNS, `run:${projectId}:${id}`).enqueueClear();
    }
  }
  await runIdx.enqueueClear();
  // versions：清索引与文档
  const verIdx = openKey<{ versions: string[]; latest: number }>(STORE_WORKFLOW_VERSIONS, `vers:${projectId}`);
  const vidx = await verIdx.load((d) => d as { versions: string[]; latest: number });
  if (vidx?.versions?.length) {
    for (const docKey of vidx.versions) {
      await openKey(STORE_WORKFLOW_VERSIONS, docKey).enqueueClear();
    }
  }
  await verIdx.enqueueClear();
}

/**
 * 阶段3 批量编排引擎（框架无关、可注入 runners，便于确定性单测）。
 *
 * 并发（docs/01）：同时分析 2 件、同时生成 1 件；每件自动修复最多 1 次。
 * 错误隔离（docs/02）：商品级错误只失败当前件；系统级错误（Key/额度/Endpoint/服务端配置/连续网络）
 *   暂停整批，进行中的该件判 interrupted，不伪装运行。
 * 人工闸门：配方在开跑前全批确认一次；身份按件确认（或显式跳过自担风险）；高风险修复必须人工确认。
 * 预算（docs/09）：开跑前已确认预计/最坏调用数；自动调用不超过最坏值，手动重试为用户显式动作。
 */
import {
  CONCURRENCY_ANALYZE,
  CONCURRENCY_GENERATE,
  CONSECUTIVE_NETWORK_FAILURE_LIMIT,
} from './batchConstants';
import {
  classifyErrorLevel,
  isNetworkError,
  batchUsesAudit,
  itemUsesIdentity,
} from './batchBudget';
import type { Batch, BatchItem } from './batchTypes';
import {
  createWorkflow,
  defaultRunners,
  humanAccept,
  uid,
  type Runners,
} from '../workflow/orchestrator';
import { transition } from '../workflow/stateMachine';
import { compilePrompt } from '../workflow/promptCompiler';
import { isHighRiskAudit } from '../workflow/workflowSchema';
import { IDENTITY_CATEGORY_LABELS } from '../shared/constants';
import { confirmFeature, hardConstraints, rejectFeature } from '../shared/schema';
import type {
  IdentityFeature,
  ModelSettings,
  SafeError,
  UploadedImage,
} from '../shared/types';
import type {
  GeneratedImage,
  GenerationAttempt,
  SingleItemWorkflow,
} from '../workflow/workflowTypes';
import type { BatchState } from '../workflow/workflowConstants';
import {
  assertBatchCompatiblePlan,
  batchPlanUsesRepair,
} from './batchExecutionPolicy';

/** 简单计数信号量 */
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.permits -= 1;
  }
  release(): void {
    this.permits += 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

export type BatchEngineOptions = {
  runners?: Runners;
  onChange?: (batch: Batch) => void;
};

export class BatchEngine {
  private batch: Batch;
  private settings: ModelSettings | null;
  private runners: Runners;
  private onChange?: (batch: Batch) => void;
  private analyzeSem = new Semaphore(CONCURRENCY_ANALYZE);
  private generateSem = new Semaphore(CONCURRENCY_GENERATE);
  private workers = new Map<string, Promise<void>>();
  private gates = new Map<string, () => void>();
  private parkers = new Map<string, Array<() => void>>();

  constructor(batch: Batch, settings: ModelSettings | null, options: BatchEngineOptions = {}) {
    this.batch = batch;
    this.settings = settings;
    this.runners = options.runners ?? defaultRunners;
    this.onChange = options.onChange;
  }

  getSnapshot(): Batch {
    return this.batch;
  }

  setSettings(settings: ModelSettings | null): void {
    this.settings = settings;
  }

  private emit(): void {
    this.onChange?.(this.batch);
  }

  private now(): string {
    return new Date().toISOString();
  }

  private getItem(itemId: string): BatchItem {
    const item = this.batch.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`批量中找不到商品 ${itemId}`);
    return item;
  }

  /** 不可变替换批次 */
  private replace(next: Batch): void {
    this.batch = { ...next, updatedAt: this.now() };
    this.emit();
  }

  private updateItem(itemId: string, patch: Partial<BatchItem>): BatchItem {
    let updated!: BatchItem;
    const items = this.batch.items.map((i) => {
      if (i.id !== itemId) return i;
      updated = { ...i, ...patch };
      return updated;
    });
    this.batch = { ...this.batch, items, updatedAt: this.now() };
    return updated;
  }

  private updateWf(itemId: string, patch: Partial<SingleItemWorkflow>): SingleItemWorkflow {
    const item = this.getItem(itemId);
    if (!item.wf) throw new Error('执行体尚未初始化');
    const wf: SingleItemWorkflow = { ...item.wf, ...patch, updatedAt: this.now() };
    this.updateItem(itemId, { wf });
    return wf;
  }

  private bumpCalls(itemId: string, n = 1): void {
    const item = this.getItem(itemId);
    const wfCalls = (item.wf?.callsUsed ?? 0) + n;
    this.batch = {
      ...this.batch,
      callsUsed: this.batch.callsUsed + n,
      updatedAt: this.now(),
    };
    if (item.wf) this.updateWf(itemId, { callsUsed: wfCalls });
  }

  /* ------------------------- 暂停 / 唤醒 ------------------------- */

  private async parkIfPaused(item: BatchItem): Promise<void> {
    const shouldPark =
      this.batch.status === 'paused' ||
      this.batch.status === 'system-paused' ||
      item.userPaused;
    if (!shouldPark) return;
    await new Promise<void>((resolve) => {
      const list = this.parkers.get(item.id) ?? [];
      list.push(resolve);
      this.parkers.set(item.id, list);
    });
  }

  private wake(itemId: string): void {
    const list = this.parkers.get(itemId) ?? [];
    this.parkers.delete(itemId);
    list.forEach((r) => r());
  }

  private wakeAll(): void {
    const all = Array.from(this.parkers.values()).flat();
    this.parkers.clear();
    all.forEach((r) => r());
  }

  private isPausedNow(itemId: string): boolean {
    const item = this.getItem(itemId);
    return (
      item.userPaused ||
      this.batch.status === 'paused' ||
      this.batch.status === 'system-paused'
    );
  }

  /**
   * 取信号量，但保证暂停/系统暂停期间绝不发起新调用：
   * 排队取到信号量时若已暂停，则释放并挂起，恢复后重新排队，避免占用并发名额空等。
   */
  private async acquireWithPause(sem: Semaphore, itemId: string): Promise<void> {
    for (;;) {
      await this.parkIfPaused(this.getItem(itemId));
      await sem.acquire();
      if (!this.isPausedNow(itemId)) return;
      sem.release();
      await this.parkIfPaused(this.getItem(itemId));
    }
  }

  private async gate(itemId: string, kind: 'identity' | 'repair' | 'accept'): Promise<void> {
    const key = `${itemId}:${kind}`;
    await new Promise<void>((resolve) => this.gates.set(key, resolve));
  }

  private releaseGate(itemId: string, kind: 'identity' | 'repair' | 'accept'): void {
    const key = `${itemId}:${kind}`;
    const r = this.gates.get(key);
    if (r) {
      this.gates.delete(key);
      r();
    }
  }

  /* ------------------------- 生命周期 ------------------------- */

  start(): void {
    if (!this.settings) throw new Error('未配置模型，无法开始批量');
    if (!this.batch.recipeConfirmed) throw new Error('请先确认视觉配方');
    if (this.batch.workflowPlan) {
      if (!this.batch.workflowVersionId) throw new Error('批次未绑定已发布工作流版本');
      assertBatchCompatiblePlan(this.batch.workflowPlan);
    } else if (!this.batch.definition) {
      throw new Error('请先选择已发布工作流版本');
    }
    if (!this.batch.budgetConfirmed || this.batch.status !== 'ready')
      throw new Error('请先确认图片分组与调用成本');
    this.batch = { ...this.batch, status: 'running', systemError: undefined };
    this.emit();
    this.batch.items.forEach((i) => {
      if (!i.skipped) this.spawnWorker(i.id);
    });
    this.settleCheck();
  }

  pauseAll(): void {
    if (this.batch.status === 'running') {
      this.replace({ ...this.batch, status: 'paused' });
      this.wakeAll();
    }
  }

  /** 继续整批（含系统错误处置后恢复）；进行中已中断件需用户逐件恢复 */
  resumeAll(): void {
    if (this.batch.status === 'paused' || this.batch.status === 'system-paused') {
      this.replace({ ...this.batch, status: 'running', systemError: undefined });
      this.wakeAll();
      this.batch.items.forEach((i) => {
        if (!i.skipped && !this.workers.has(i.id)) this.spawnWorker(i.id);
      });
      this.settleCheck();
    }
  }

  pauseItem(itemId: string): void {
    this.updateItem(itemId, { userPaused: true });
    this.emit();
    this.wake(itemId);
  }

  resumeItem(itemId: string): void {
    const item = this.getItem(itemId);
    let wf = item.wf;
    if (wf?.state === 'interrupted') {
      // 进行中被中断（含系统暂停）的半成品不自动续跑：重建干净工作流重新推进，
      // 保留已确认身份与已用调用计数，但不计入“手动重试”。
      wf = this.rebuildWorkflow(item);
    }
    this.updateItem(itemId, { userPaused: false, wf, awaiting: null });
    this.emit();
    this.wake(itemId);
    if (!this.workers.has(itemId)) this.spawnWorker(itemId);
  }

  skipItem(itemId: string): void {
    const item = this.getItem(itemId);
    const inFlight = item.wf
      ? ['analyzing', 'generating', 'auditing', 'repairing'].includes(item.wf.state)
      : false;
    if (inFlight) throw new Error('该件正在调用模型，无法跳过；请先暂停该件或等待本次调用结束');
    this.updateItem(itemId, { skipped: true, userPaused: false, awaiting: null, finishedAt: this.now() });
    if (item.wf && (item.wf.state === 'warning' || item.wf.state === 'needs-review' || item.wf.state === 'paused')) {
      this.updateWf(itemId, { state: 'failed' });
    }
    this.emit();
    ['identity', 'repair', 'accept'].forEach((k) =>
      this.releaseGate(itemId, k as 'identity' | 'repair' | 'accept'),
    );
    this.wake(itemId);
    this.settleCheck();
  }

  /** 为某件重建干净工作流（保留共享配方、已确认身份与已用调用计数） */
  private rebuildWorkflow(item: BatchItem): SingleItemWorkflow {
    if (!this.batch.recipe) throw new Error('缺少已确认配方');
    const fresh = createWorkflow({
      referenceImages: this.batch.referenceImages,
      productImages: item.images,
      taskPurpose: this.batch.taskPurpose,
      name: item.name,
    });
    const prev = item.wf;
    fresh.recipe = this.batch.recipe;
    fresh.recipeConfirmed = true;
    fresh.workflowDefinitionId = this.batch.workflowVersionId ?? this.batch.definition?.id;
    fresh.state = 'queued';
    if (prev?.identityConfirmed) {
      fresh.identityFeatures = prev.identityFeatures;
      fresh.identityConfirmed = true;
    }
    if (prev) fresh.callsUsed = prev.callsUsed;
    return fresh;
  }

  /** 手动重试终态失败/中断件（用户显式动作，计入 retryCount，可超出自动最坏预算） */
  retryItem(itemId: string): void {
    const item = this.getItem(itemId);
    if (item.skipped) {
      this.updateItem(itemId, { skipped: false, finishedAt: undefined });
    }
    const prev = this.getItem(itemId).wf;
    if (prev && !['failed', 'interrupted'].includes(prev.state) && !item.skipped) {
      throw new Error('仅失败或中断的商品可以手动重试');
    }
    const fresh = this.rebuildWorkflow(this.getItem(itemId));
    this.updateItem(itemId, {
      wf: fresh,
      userPaused: false,
      skipped: false,
      awaiting: null,
      retryCount: item.retryCount + 1,
      startedAt: this.now(),
      finishedAt: undefined,
    });
    this.emit();
    if (this.batch.status === 'completed' || this.batch.status === 'paused' || this.batch.status === 'system-paused') {
      this.batch = { ...this.batch, status: 'running', systemError: undefined };
      this.emit();
    }
    this.wake(itemId);
    if (!this.workers.has(itemId)) this.spawnWorker(itemId);
  }

  /* ------------------------- 人工闸门动作 ------------------------- */

  confirmIdentity(itemId: string, features?: IdentityFeature[]): void {
    const item = this.getItem(itemId);
    if (!item.wf) throw new Error('该件尚未提取身份特征');
    const finalFeatures = features ?? item.wf.identityFeatures;
    const wf: SingleItemWorkflow = {
      ...item.wf,
      identityFeatures: finalFeatures,
      identityConfirmed: true,
      updatedAt: this.now(),
    };
    this.updateItem(itemId, { wf, awaiting: null });
    this.emit();
    this.releaseGate(itemId, 'identity');
  }

  /** 跳过身份锁定：模型候选保持 pending，不进入硬约束（风险由用户承担） */
  skipIdentity(itemId: string): void {
    const item = this.getItem(itemId);
    if (!item.wf) throw new Error('该件尚未提取身份特征');
    const wf: SingleItemWorkflow = { ...item.wf, identityConfirmed: true, updatedAt: this.now() };
    this.updateItem(itemId, { wf, awaiting: null, identityMode: 'skip' });
    this.emit();
    this.releaseGate(itemId, 'identity');
  }

  setFeature(itemId: string, featureId: string, status: 'confirmed' | 'rejected'): void {
    const item = this.getItem(itemId);
    if (!item.wf) return;
    const features = item.wf.identityFeatures.map((f) =>
      f.id === featureId ? (status === 'confirmed' ? confirmFeature(f) : rejectFeature(f)) : f,
    );
    this.updateWf(itemId, { identityFeatures: features });
    this.emit();
  }

  acceptItem(itemId: string): void {
    const item = this.getItem(itemId);
    if (!item.wf) return;
    const wf = humanAccept(item.wf);
    this.updateItem(itemId, { wf, awaiting: null, finishedAt: this.now() });
    this.emit();
    this.releaseGate(itemId, 'accept');
  }

  applyRepair(itemId: string): void {
    const item = this.getItem(itemId);
    const wf0 = item.wf;
    const v2 = wf0?.attempts.find((a) => a.version === 2);
    if (!wf0 || !v2?.repair) throw new Error('没有待确认的修复方案');
    const base = wf0.attempts.find((a) => a.version === 1);
    const positive = v2.repair.positivePromptOverride?.trim() || base?.prompt.positivePrompt || '';
    const negative = [base?.prompt.negativePrompt ?? '', ...v2.repair.addedNegative.map((s) => `避免：${s}`)]
      .filter(Boolean)
      .join('；');
    v2.prompt = { ...v2.prompt, positivePrompt: positive, negativePrompt: negative };
    v2.repair.confirmedAt = this.now();
    const wf: SingleItemWorkflow = {
      ...wf0,
      repairUsed: true,
      attempts: [...wf0.attempts],
      updatedAt: this.now(),
    };
    this.updateItem(itemId, { wf, awaiting: null });
    this.emit();
    this.releaseGate(itemId, 'repair');
  }

  /* ------------------------- 工作器 ------------------------- */

  private spawnWorker(itemId: string): void {
    if (this.workers.has(itemId)) return;
    const p = this.runItem(itemId).finally(() => {
      this.workers.delete(itemId);
      this.settleCheck();
    });
    this.workers.set(itemId, p);
  }

  private ensureWf(item: BatchItem): SingleItemWorkflow {
    if (item.wf) return item.wf;
    if (!this.batch.recipe || (!this.batch.workflowVersionId && !this.batch.definition)) {
      throw new Error('缺少已确认配方/发布版本');
    }
    const wf = createWorkflow({
      referenceImages: this.batch.referenceImages,
      productImages: item.images,
      taskPurpose: this.batch.taskPurpose,
      name: item.name,
    });
    wf.recipe = this.batch.recipe;
    wf.recipeConfirmed = true;
    wf.workflowDefinitionId = this.batch.workflowVersionId ?? this.batch.definition!.id;
    wf.state = 'queued';
    const updated = this.updateItem(item.id, { wf, startedAt: this.now() });
    return updated.wf!;
  }

  private async runItem(itemId: string): Promise<void> {
    // 单次工作器在其生命周期内推进该件直到终态/跳过/暂停停车
    for (;;) {
      let item = this.getItem(itemId);
      if (item.skipped) return;
      await this.parkIfPaused(item);
      item = this.getItem(itemId);
      if (item.skipped) return;
      if (!this.settings) return;

      this.ensureWf(item);
      item = this.getItem(itemId);
      const wf = item.wf!;
      const useIdentity = itemUsesIdentity(this.batch, item);
      const useAudit = batchUsesAudit(this.batch);

      // 1) 身份阶段
      if (!wf.identityConfirmed) {
        if (useIdentity && wf.identityFeatures.length === 0) {
          const cont = await this.runIdentity(itemId);
          if (!cont) return; // 系统暂停/跳过
          continue;
        }
        if (useIdentity && wf.identityFeatures.length > 0) {
          this.updateItem(itemId, { awaiting: 'identity' });
          this.emit();
          await this.gate(itemId, 'identity');
          continue;
        }
        // 显式跳过身份锁定：无硬约束，直接进入生成
        this.updateWf(itemId, { identityConfirmed: true });
        this.emit();
        continue;
      }

      // 2) 人工接受 warning / needs-review
      if (wf.state === 'warning' || wf.state === 'needs-review') {
        this.updateItem(itemId, { awaiting: 'accept' });
        this.emit();
        await this.gate(itemId, 'accept');
        continue;
      }

      // 3) 失败 → 自动修复一次（高风险停车人工确认）
      if (wf.state === 'failed') {
        const last = wf.attempts[wf.attempts.length - 1];
        const canRepair =
          useAudit &&
          batchPlanUsesRepair(this.batch) &&
          !wf.repairUsed &&
          !!last?.audit &&
          !!last.image &&
          wf.attempts.length < 2;
        if (!canRepair) return; // 终态失败，等待用户手动重试/跳过
        const cont = await this.runRepair(itemId);
        if (!cont) return;
        continue;
      }

      // 4) 修复方案待确认（高风险停车）
      const pendingV2 = wf.attempts.find((a) => a.version === 2 && a.repair && !a.repair.confirmedAt);
      if (wf.state === 'paused' && pendingV2) {
        this.updateItem(itemId, { awaiting: 'repair' });
        this.emit();
        await this.gate(itemId, 'repair');
        continue;
      }

      // 5) 生成（首版 v1，或应用修复后的 v2）
      const v2Confirmed = wf.attempts.find((a) => a.version === 2 && a.repair?.confirmedAt);
      const canGenerate =
        (wf.state === 'draft' || wf.state === 'queued') && wf.attempts.length === 0;
      const canRegenerate = wf.state === 'paused' && !!v2Confirmed;
      if (canGenerate || canRegenerate) {
        const cont = await this.runGenerate(itemId, { useAudit, regenerate: canRegenerate });
        if (!cont) return;
        continue;
      }

      // 终态或无可推进动作
      if (['passed', 'failed'].includes(wf.state)) {
        const done = this.getItem(itemId);
        if (!done.finishedAt) this.updateItem(itemId, { finishedAt: this.now() });
        this.emit();
        return;
      }
      // 兜底：避免空转
      return;
    }
  }

  /** 身份提取；返回 false 表示应结束本工作器（系统暂停/跳过） */
  private async runIdentity(itemId: string): Promise<boolean> {
    const item = this.getItem(itemId);
    const sem = this.analyzeSem;
    await this.acquireWithPause(sem, itemId);
    try {
      if (this.getItem(itemId).skipped) return false;
      let wf = this.updateWf(itemId, {
        state: transition(item.wf!.state, 'START_ANALYSIS'),
        currentNodeId: 'identityLock',
        lastError: undefined,
      });
      this.emit();
      const res = await this.runners.identity(this.settings!, wf.productImages, this.batch.taskPurpose);
      if (!res.ok) {
        return this.handleCallError(itemId, res, 'analyze', sem, 'identity');
      }
      this.bumpCalls(itemId);
      this.batch = { ...this.batch, consecutiveNetworkFailures: 0 };
      wf = this.updateWf(itemId, {
        identityFeatures: res.data,
        state: transition(this.getItem(itemId).wf!.state, 'ANALYSIS_FINISHED'),
        currentNodeId: undefined,
      });
      this.emit();
      return true;
    } finally {
      sem.release();
    }
  }

  /** 修复提案；低风险自动应用，高风险停车 */
  private async runRepair(itemId: string): Promise<boolean> {
    const item = this.getItem(itemId);
    const wf = item.wf!;
    const last = wf.attempts[wf.attempts.length - 1];
    if (!last.audit || !last.image || !wf.recipe) return false;
    const highRisk = isHighRiskAudit(last.audit.issues);
    const statements = hardConstraints(wf.identityFeatures).map(
      (f) => `[${IDENTITY_CATEGORY_LABELS[f.category] ?? f.category}] ${f.statement}`,
    );
    const sem = this.analyzeSem;
    await this.acquireWithPause(sem, itemId);
    try {
      if (this.getItem(itemId).skipped) return false;
      this.updateWf(itemId, {
        state: transition(wf.state, 'START_REPAIR', { repairUsed: wf.repairUsed }),
        currentNodeId: 'targetedRepair',
      });
      this.emit();
      const candidate: UploadedImage = {
        id: last.image.id,
        dataUri: last.image.dataUri,
        mediaType: last.image.mediaType,
        name: 'generated.png',
      };
      const res = await this.runners.repair(
        this.settings!,
        wf.productImages,
        candidate,
        last.audit,
        last.prompt,
        statements,
        highRisk,
      );
      if (!res.ok) return this.handleCallError(itemId, res, 'analyze', sem, 'repair');
      this.bumpCalls(itemId);
      this.batch = { ...this.batch, consecutiveNetworkFailures: 0 };
      const v2: GenerationAttempt = {
        id: uid('att'),
        version: 2,
        status: 'pending',
        prompt: { ...last.prompt, compiledAt: this.now() },
        repair: { ...res.data, raw: res.raw.rawContent },
      };
      this.updateWf(itemId, {
        attempts: [...wf.attempts, v2],
        state: transition(this.getItem(itemId).wf!.state, 'REPAIR_PROPOSED'),
        currentNodeId: undefined,
      });
      this.emit();
      if (!highRisk) {
        // 低风险：自动应用并继续重生成（仍只此一次）
        this.applyRepair(itemId);
      }
      return true;
    } finally {
      sem.release();
    }
  }

  private async runGenerate(
    itemId: string,
    opts: { useAudit: boolean; regenerate: boolean },
  ): Promise<boolean> {
    const item = this.getItem(itemId);
    let wf = item.wf!;
    const sem = this.generateSem;
    await this.acquireWithPause(sem, itemId);
    try {
      if (this.getItem(itemId).skipped) return false;
      wf = this.getItem(itemId).wf!;

      let attempt: GenerationAttempt;
      if (opts.regenerate) {
        const v2 = wf.attempts.find((a) => a.version === 2)!;
        attempt = v2;
        this.updateWf(itemId, {
          state: transition(wf.state, 'APPLY_REPAIR'),
          currentNodeId: 'sceneGenerator',
        });
      } else {
        if (!wf.recipe) throw new Error('缺少已确认配方');
        const compiled = compilePrompt(wf.recipe, wf.identityFeatures, wf.taskPurpose);
        attempt = { id: uid('att'), version: 1, status: 'pending', prompt: compiled };
        this.updateWf(itemId, {
          attempts: [attempt],
          state: transition(wf.state, 'START_GENERATION'),
          currentNodeId: 'sceneGenerator',
        });
      }
      wf = this.getItem(itemId).wf!;
      attempt.status = 'generating';
      attempt.startedAt = this.now();
      this.emit();

      const folded = attempt.prompt.negativePrompt
        ? `${attempt.prompt.positivePrompt}\n\n${attempt.prompt.negativePrompt}`
        : attempt.prompt.positivePrompt;
      const imgRes = await this.runners.image(this.settings!, folded, attempt.prompt.negativePrompt);
      if (!imgRes.ok) {
        attempt.status = 'generation-failed';
        return this.handleCallError(itemId, imgRes, 'generate', sem, 'image', attempt);
      }
      const image: GeneratedImage = {
        id: uid('img'),
        mediaType: imgRes.mediaType,
        dataUri: `data:${imgRes.mediaType};base64,${imgRes.b64Json}`,
      };
      attempt.image = image;
      attempt.generateDiagnostics = imgRes.diagnostics;
      this.bumpCalls(itemId);
      this.batch = { ...this.batch, consecutiveNetworkFailures: 0 };

      // 跳过验收：只生成、不验证，结论只能是 needs-review（不冒充通过）
      if (!opts.useAudit) {
        attempt.status = 'needs-review';
        attempt.finishedAt = this.now();
        this.updateWf(itemId, {
          state: transition(this.getItem(itemId).wf!.state, 'GENERATION_SUCCEEDED'),
          currentNodeId: undefined,
        });
        const mid = this.getItem(itemId).wf!;
        this.updateWf(itemId, {
          state: transition(mid.state, 'AUDIT_FINISHED', { auditStatus: 'needs-review' }),
          currentNodeId: undefined,
        });
        this.updateItem(itemId, { awaiting: 'accept', finishedAt: undefined });
        this.emit();
        return true;
      }

      this.updateWf(itemId, {
        state: transition(this.getItem(itemId).wf!.state, 'GENERATION_SUCCEEDED'),
        currentNodeId: 'resultAuditor',
      });
      attempt.status = 'auditing';
      this.emit();
      wf = this.getItem(itemId).wf!;
      const candidate: UploadedImage = {
        id: image.id,
        dataUri: image.dataUri,
        mediaType: image.mediaType,
        name: 'generated.png',
      };
      const auditRes = await this.runners.audit(
        this.settings!,
        wf.productImages,
        candidate,
        wf.recipe!,
        wf.taskPurpose,
      );
      if (!auditRes.ok) {
        attempt.status = 'audit-failed';
        return this.handleCallError(itemId, auditRes, 'generate', sem, 'audit', attempt);
      }
      attempt.audit = auditRes.data;
      attempt.auditDiagnostics = auditRes.raw.diagnostics;
      attempt.status = auditRes.data.status;
      attempt.finishedAt = this.now();
      this.bumpCalls(itemId);
      this.batch = { ...this.batch, consecutiveNetworkFailures: 0 };
      this.updateWf(itemId, {
        state: transition(this.getItem(itemId).wf!.state, 'AUDIT_FINISHED', {
          auditStatus: auditRes.data.status,
        }),
        currentNodeId: undefined,
      });
      if (auditRes.data.status === 'passed') {
        this.updateItem(itemId, { finishedAt: this.now() });
      }
      this.emit();
      return true;
    } finally {
      sem.release();
    }
  }

  /**
   * 统一处理调用失败：系统级→暂停整批并把该件判 interrupted；
   * 网络连续达阈值→系统级；其余商品级→仅失败当前件（错误隔离）。
   * 返回 false 表示本工作器应结束。
   */
  private handleCallError(
    itemId: string,
    error: SafeError,
    semKind: 'analyze' | 'generate',
    sem: Semaphore,
    call: string,
    attempt?: GenerationAttempt,
  ): boolean {
    void semKind;
    void sem;
    void call;
    const level = classifyErrorLevel(error);
    const network = isNetworkError(error);

    // 商品级失败
    if (level === 'item') {
      let consecutive = this.batch.consecutiveNetworkFailures;
      if (network) {
        consecutive += 1;
        this.batch = { ...this.batch, consecutiveNetworkFailures: consecutive };
      } else {
        this.batch = { ...this.batch, consecutiveNetworkFailures: 0 };
      }
      if (network && consecutive >= CONSECUTIVE_NETWORK_FAILURE_LIMIT) {
        return this.systemPause(itemId, error, attempt);
      }
      const wf = this.getItem(itemId).wf!;
      const failable: BatchState[] = ['analyzing', 'generating', 'auditing', 'repairing', 'queued'];
      const state = failable.includes(wf.state) ? transition(wf.state, 'FAIL') : wf.state;
      this.updateWf(itemId, { state, lastError: error });
      this.updateItem(itemId, { awaiting: null, finishedAt: this.now() });
      this.emit();
      return false;
    }

    // 系统级：暂停整批
    return this.systemPause(itemId, error, attempt);
  }

  private systemPause(itemId: string, error: SafeError, attempt?: GenerationAttempt): boolean {
    void attempt;
    const item = this.getItem(itemId);
    if (item.wf) {
      const s = item.wf.state;
      if (['analyzing', 'generating', 'auditing', 'repairing', 'queued'].includes(s)) {
        this.updateWf(itemId, { state: transition(s, 'MARK_INTERRUPTED'), lastError: error });
      } else {
        this.updateWf(itemId, { lastError: error });
      }
    }
    this.updateItem(itemId, { userPaused: true, awaiting: null });
    this.batch = {
      ...this.batch,
      status: 'system-paused',
      systemError: error,
      updatedAt: this.now(),
    };
    this.emit();
    this.wakeAll();
    return false;
  }

  private settleCheck(): void {
    if (this.batch.status !== 'running') return;
    if (this.workers.size > 0) return;
    const allDone = this.batch.items.every((i) => {
      if (i.skipped) return true;
      const s = i.wf?.state;
      // warning/needs-review 的工作器仍停在人工闸门（workers.size>0），走到这里时应已处置为 passed/skipped
      return s === 'passed' || s === 'failed';
    });
    if (allDone) {
      this.replace({ ...this.batch, status: 'completed' });
    }
  }
}

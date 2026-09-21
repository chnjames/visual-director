/**
 * 画布节点派生模型（docs/12 §4/§5）。
 *
 * 唯一事实来源是 SingleItemWorkflow（经状态机推进）；画布不持有任何业务状态，
 * 节点视觉态、摘要、完成度全部由 wf 单向派生，避免“画出来的状态”与真实执行不一致。
 */
import type { SingleItemWorkflow } from '../../workflow/workflowTypes';
import { WORKFLOW_NODE_IDS, type WorkflowNodeId } from '../../workflow/workflowConstants';

/** docs/12 §5 统一节点状态 */
export type NodeVisualState =
  | 'unconfigured' // 未配置
  | 'waiting' // 等待
  | 'running' // 运行中
  | 'review' // 待确认
  | 'done' // 已完成
  | 'warning' // 警告（保留输出）
  | 'failed' // 失败
  | 'skipped'; // 已跳过

export type NodeSummary = {
  id: WorkflowNodeId;
  state: NodeVisualState;
  /** 节点主摘要（一行） */
  title: string;
  /** 次要摘要行（数量/完成度/置信度） */
  lines: string[];
  /** 是否有待人工处理的明确动作 */
  action?: string;
};

export const NODE_DEFAULT_POSITIONS: Record<WorkflowNodeId, { x: number; y: number }> = {
  // 三列布局：输入（左）→ 理解/锁定（中）→ 生成/验收/修复（右）
  referenceInput: { x: 56, y: 64 },
  productInput: { x: 56, y: 336 },
  recipeExtractor: { x: 376, y: 64 },
  identityLock: { x: 376, y: 336 },
  sceneGenerator: { x: 696, y: 64 },
  resultAuditor: { x: 696, y: 336 },
  targetedRepair: { x: 1016, y: 336 },
};

/** 固定只读连接（docs/12 §3：首版连线只读，业务无环） */
export const FIXED_EDGES: Array<{
  from: WorkflowNodeId;
  to: WorkflowNodeId;
  conditional?: 'on-fail';
}> = [
  { from: 'referenceInput', to: 'recipeExtractor' },
  { from: 'productInput', to: 'identityLock' },
  { from: 'recipeExtractor', to: 'identityLock' },
  { from: 'identityLock', to: 'sceneGenerator' },
  { from: 'sceneGenerator', to: 'resultAuditor' },
  { from: 'resultAuditor', to: 'targetedRepair', conditional: 'on-fail' },
];

export const NODE_W = 264;
export const NODE_H = 128;

function latestAttempt(wf: SingleItemWorkflow | null) {
  return wf?.attempts[wf.attempts.length - 1];
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * 由单件工作流派生全部节点的视觉状态与摘要。
 * wf 为 null（新项目/未开始）时给出“未配置/空节点告诉用户需要什么”的引导态。
 */
export function deriveNodeSummaries(wf: SingleItemWorkflow | null): NodeSummary[] {
  if (!wf) {
    return [
      {
        id: 'referenceInput',
        state: 'unconfigured',
        title: '参考图',
        lines: ['需要 1–5 张参考图'],
        action: '上传参考图',
      },
      {
        id: 'productInput',
        state: 'unconfigured',
        title: '商品图',
        lines: ['需要同一商品 2–3 张多角度图'],
        action: '上传商品图',
      },
      { id: 'recipeExtractor', state: 'unconfigured', title: '视觉配方', lines: ['上传参考图后可提取'] },
      { id: 'identityLock', state: 'unconfigured', title: '商品身份锁定', lines: ['上传商品图后可提取'] },
      { id: 'sceneGenerator', state: 'unconfigured', title: 'Prompt 编译与场景生成', lines: ['两道闸门确认后可运行'] },
      { id: 'resultAuditor', state: 'unconfigured', title: '结果验收', lines: ['生成后自动四维验收'] },
      { id: 'targetedRepair', state: 'unconfigured', title: '定向修复', lines: ['仅验收失败后启用，每件一次'] },
    ];
  }

  const refs = wf.referenceImages.length;
  const prods = wf.productImages.length;
  const recipe = wf.recipe;
  const confirmedFeatures = wf.identityFeatures.filter((f) => f.status === 'confirmed').length;
  const pendingFeatures = wf.identityFeatures.filter((f) => f.status === 'pending').length;
  const last = latestAttempt(wf);
  const audit = last?.audit;

  const out: NodeSummary[] = [];

  // 参考图输入
  out.push({
    id: 'referenceInput',
    state: refs > 0 ? 'done' : 'unconfigured',
    title: '参考图',
    lines: refs > 0 ? [`${refs} 张参考图`] : ['需要 1–5 张参考图'],
    action: refs > 0 ? undefined : '上传参考图',
  });

  // 商品图输入
  out.push({
    id: 'productInput',
    state: prods >= 2 ? 'done' : 'unconfigured',
    title: '商品图',
    lines: prods >= 2 ? [`${prods} 张多角度图`] : ['需要同一商品 2–3 张多角度图'],
    action: prods >= 2 ? undefined : '上传商品图',
  });

  // 视觉配方
  if (wf.state === 'analyzing' && !recipe) {
    out.push({ id: 'recipeExtractor', state: 'running', title: '视觉配方', lines: ['正在提取 12 个视觉字段…'] });
  } else if (recipe && !wf.recipeConfirmed) {
    const avg =
      recipe.fields.reduce((s, f) => s + f.confidence, 0) / Math.max(1, recipe.fields.length);
    out.push({
      id: 'recipeExtractor',
      state: 'review',
      title: '视觉配方',
      lines: [`12 字段已提取 · 平均置信 ${pct(avg)}`, '待你确认迁移边界'],
      action: '确认视觉配方',
    });
  } else if (wf.recipeConfirmed) {
    out.push({
      id: 'recipeExtractor',
      state: 'done',
      title: '视觉配方',
      lines: ['12 字段已确认', `确认于 ${new Date(recipe!.confirmedAt!).toLocaleString()}`],
    });
  } else {
    out.push({
      id: 'recipeExtractor',
      state: refs > 0 ? 'waiting' : 'unconfigured',
      title: '视觉配方',
      lines: refs > 0 ? ['可运行：提取视觉配方'] : ['上传参考图后可提取'],
      action: refs > 0 ? '运行此节点' : undefined,
    });
  }

  // 身份锁定
  if (wf.state === 'analyzing' && recipe && wf.identityFeatures.length === 0) {
    out.push({ id: 'identityLock', state: 'running', title: '商品身份锁定', lines: ['正在提取候选特征…'] });
  } else if (!wf.identityConfirmed && wf.identityFeatures.length > 0) {
    out.push({
      id: 'identityLock',
      state: 'review',
      title: '商品身份锁定',
      lines: [
        `候选 ${wf.identityFeatures.length} · 已确认 ${confirmedFeatures} · 待确认 ${pendingFeatures}`,
        '模型推测不会自动成为硬约束',
      ],
      action: '逐条确认身份特征',
    });
  } else if (wf.identityConfirmed) {
    out.push({
      id: 'identityLock',
      state: 'done',
      title: '商品身份锁定',
      lines:
        confirmedFeatures > 0
          ? [`${confirmedFeatures} 条硬约束已锁定`]
          : ['已跳过（无硬约束）'],
    });
  } else {
    out.push({
      id: 'identityLock',
      state: prods >= 2 ? 'waiting' : 'unconfigured',
      title: '商品身份锁定',
      lines: prods >= 2 ? ['配方确认后提取候选'] : ['上传商品图后可提取'],
    });
  }

  // 场景生成
  if (wf.state === 'generating') {
    out.push({ id: 'sceneGenerator', state: 'running', title: 'Prompt 编译与场景生成', lines: ['正在生成场景图…'] });
  } else if (last?.image) {
    out.push({
      id: 'sceneGenerator',
      state: 'done',
      title: 'Prompt 编译与场景生成',
      lines: [`已生成 V${last.version}`, `模型调用 ${wf.callsUsed} 次`],
    });
  } else if (wf.identityConfirmed) {
    out.push({
      id: 'sceneGenerator',
      state: 'waiting',
      title: 'Prompt 编译与场景生成',
      lines: ['Prompt 已由结构化配方编译', '可运行：生成场景图'],
      action: '运行此节点',
    });
  } else {
    out.push({ id: 'sceneGenerator', state: 'unconfigured', title: 'Prompt 编译与场景生成', lines: ['两道闸门确认后可运行'] });
  }

  // 结果验收
  if (wf.state === 'auditing') {
    out.push({ id: 'resultAuditor', state: 'running', title: '结果验收', lines: ['正在四维验收…'] });
  } else if (audit) {
    const state: NodeVisualState =
      audit.status === 'passed'
        ? 'done'
        : audit.status === 'failed'
          ? 'failed'
          : audit.status === 'warning'
            ? 'warning'
            : 'review';
    out.push({
      id: 'resultAuditor',
      state,
      title: '结果验收',
      lines: [
        `综合 ${audit.compositeScore} · 身份 ${audit.identityScore} / 配方 ${audit.recipeScore}`,
        `问题 ${audit.issues.length} 项`,
      ],
      action:
        audit.status === 'warning' || audit.status === 'needs-review'
          ? '人工确认结论'
          : undefined,
    });
  } else if (last?.image) {
    out.push({ id: 'resultAuditor', state: 'waiting', title: '结果验收', lines: ['图片已生成，待验收'] });
  } else {
    out.push({ id: 'resultAuditor', state: 'unconfigured', title: '结果验收', lines: ['生成后自动四维验收'] });
  }

  // 定向修复
  if (wf.state === 'repairing') {
    out.push({ id: 'targetedRepair', state: 'running', title: '定向修复', lines: ['正在生成修复方案…'] });
  } else if (wf.repairUsed) {
    out.push({
      id: 'targetedRepair',
      state: 'done',
      title: '定向修复',
      lines: ['唯一次修复已使用', 'V2 已重新生成并验收'],
    });
  } else if (wf.state === 'paused' && wf.attempts.some((a) => a.repair && !a.repair.confirmedAt)) {
    out.push({
      id: 'targetedRepair',
      state: 'review',
      title: '定向修复',
      lines: ['修复方案待确认（受限 Patch）'],
      action: '审查并确认修复',
    });
  } else if (audit?.status === 'failed') {
    out.push({
      id: 'targetedRepair',
      state: 'failed',
      title: '定向修复',
      lines: ['验收未通过', '可生成一次定向修复方案'],
      action: '生成修复方案',
    });
  } else {
    out.push({ id: 'targetedRepair', state: 'skipped', title: '定向修复', lines: ['仅验收失败后启用'] });
  }

  return out;
}

export const ALL_NODE_IDS = WORKFLOW_NODE_IDS;

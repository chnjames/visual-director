/**
 * Prompt 优化（docs/12 §七 + docs/15 安全边界）。
 *
 * 复用现有 runProbe 文本通道，不新增网络/代理逻辑。
 * 关键约束：
 * - 模型只给“建议”，由用户在 UI 确认后才写回节点配置，绝不自动覆盖；
 * - 已确认的商品身份/配方事实作为不可改写的系统约束随请求发送；
 * - 不允许模型凭空新增材质/颜色/部件，只优化构图/光线/背景/镜头/商业表达/负面词；
 * - 调用失败返回错误，调用方保留原提示词。
 */
import { runProbe } from '../model/arkClient';
import type { ModelSettings } from '../shared/types';

export type PromptOptimizationResult = {
  optimizedPrompt: string;
  changes: string[]; // 主要修改说明
  affectsIdentity: boolean; // 模型自判是否触碰身份事实（仍需用户确认）
  introducesFacts: boolean; // 是否疑似引入未确认事实
};

const SYSTEM_PROMPT = `你是电商静物商品图的提示词优化助手。
你只能优化以下方面：构图、镜头、光线、背景、色调氛围、商业表达、以及负面约束。
严禁：删除或改写已确认的商品身份事实（形状、颜色、材质、结构、Logo）；凭空添加商品材质、颜色、部件；改变商品本体；照抄参考图中的受保护内容。
必须返回 JSON：{"optimizedPrompt": string, "changes": string[], "affectsIdentity": boolean, "introducesFacts": boolean}，不要输出 JSON 以外内容。`;

function assemble(raw: unknown): PromptOptimizationResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const optimized = typeof o.optimizedPrompt === 'string' ? o.optimizedPrompt : '';
  if (!optimized.trim()) throw new Error('模型未返回优化后的提示词');
  const changes = Array.isArray(o.changes) ? o.changes.filter((c): c is string => typeof c === 'string') : [];
  return {
    optimizedPrompt: optimized,
    changes,
    affectsIdentity: o.affectsIdentity === true,
    introducesFacts: o.introducesFacts === true,
  };
}

export async function optimizePrompt(
  settings: ModelSettings | null,
  input: {
    originalPrompt: string;
    negativePrompt?: string;
    identityFacts?: string; // 已确认身份（只读约束）
    visualRecipe?: string; // 已确认配方（只读约束）
    taskPurpose?: string;
  },
): Promise<
  | { ok: true; data: PromptOptimizationResult }
  | { ok: false; errorClass: string; message: string }
> {
  const userContent = [
    input.visualRecipe ? `已确认视觉配方（不可改写）：\n${input.visualRecipe}` : '',
    input.identityFacts ? `已确认商品身份事实（不可改写）：\n${input.identityFacts}` : '',
    input.taskPurpose ? `场景用途：${input.taskPurpose}` : '',
    input.negativePrompt ? `当前负面提示词：\n${input.negativePrompt}` : '',
    `请优化下面的主提示词：\n${input.originalPrompt}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const outcome = await runProbe<PromptOptimizationResult>(
    'audit', // 复用文本通道的 kind（仅决定超时/模型选择，不影响安全）
    settings,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    assemble,
  );

  if (outcome.ok) return { ok: true, data: outcome.data };
  return { ok: false, errorClass: outcome.errorClass, message: outcome.message };
}

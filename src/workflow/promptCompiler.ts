/**
 * Prompt 编译器（docs/04「Prompt编译器」）。
 *
 * 唯一事实来源：已确认的结构化 VisualRecipe + 用户已确认(confirmed)的 IdentityFeature。
 * - 编译是单向、确定性的：用户可以查看最终 Prompt，但不能让自由文本反向覆盖已确认结构；
 * - 模型推测的身份特征（pending/rejected）不进入硬约束；
 * - 负向约束合并配方 forbidden 与通用安全负向（不复制第三方 Logo/水印/文字等，docs/01 素材边界）。
 */
import { IDENTITY_CATEGORY_LABELS, RECIPE_FIELD_KEYS, RECIPE_FIELD_LABELS } from '../shared/constants';
import { hardConstraints } from '../shared/schema';
import type { IdentityFeature, VisualRecipe } from '../shared/types';
import type { CompiledPrompt } from './workflowTypes';

const GENERIC_NEGATIVE = [
  '改变商品本身的形状、关键部件、颜色或材质',
  '新增、替换或遗漏商品关键部件',
  '出现第三方品牌 Logo、水印、二维码',
  '乱码、虚构或多余的文字',
  '变形、畸变、低清晰度、噪点、穿帮',
];

function requireConfirmedRecipe(recipe: VisualRecipe): void {
  if (!recipe || !recipe.confirmedAt) {
    throw new Error('视觉配方尚未经用户确认，不能编译生成 Prompt');
  }
  const have = new Set(recipe.fields.map((f) => f.key));
  const missing = RECIPE_FIELD_KEYS.filter((k) => !have.has(k));
  if (missing.length > 0) {
    throw new Error(`视觉配方字段不完整，缺少：${missing.join('、')}`);
  }
}

/**
 * 编译图片模型 Prompt。
 * @param recipe 已确认视觉配方（confirmedAt 必填，12 字段齐全）
 * @param features 身份候选（仅 confirmed 进入硬约束）
 * @param taskPurpose 场景用途（可选，仅作任务说明，不能覆盖结构）
 */
export function compilePrompt(
  recipe: VisualRecipe,
  features: IdentityFeature[],
  taskPurpose = '',
): CompiledPrompt {
  requireConfirmedRecipe(recipe);

  const hard = hardConstraints(features);
  const identityConstraints = hard.map(
    (f) => `[${IDENTITY_CATEGORY_LABELS[f.category] ?? f.category}] 保持：${f.statement}`,
  );

  // 按合同顺序输出 12 字段，保证确定性
  const byKey = new Map(recipe.fields.map((f) => [f.key, f]));
  const fieldValues: Record<string, string> = {};
  const fieldLines: string[] = [];
  for (const key of RECIPE_FIELD_KEYS) {
    const f = byKey.get(key);
    if (!f) continue;
    fieldValues[key] = f.value;
    fieldLines.push(`${RECIPE_FIELD_LABELS[key] ?? key}：${f.value}`);
  }

  const positiveParts: string[] = [];
  positiveParts.push('任务：生成一张用于电商展示的静物商品场景图，商品本体必须与身份约束完全一致。');
  if (taskPurpose.trim()) {
    positiveParts.push(`用途：${taskPurpose.trim()}`);
  }
  if (identityConstraints.length > 0) {
    positiveParts.push(
      `必须严格保持的商品身份特征（最高优先级）：\n${identityConstraints.map((s) => `- ${s}`).join('\n')}`,
    );
  } else {
    positiveParts.push('必须严格保持商品本体的形状、关键部件、颜色、材质与纹理不变。');
  }
  positiveParts.push(`视觉配方（商品无关、可迁移的视觉规则）：\n${fieldLines.map((l) => `- ${l}`).join('\n')}`);
  if (recipe.required.length > 0) {
    positiveParts.push(`必须保持：\n${recipe.required.map((s) => `- ${s}`).join('\n')}`);
  }
  if (recipe.variable.length > 0) {
    positiveParts.push(`允许在不违背上述约束的前提下变化：\n${recipe.variable.map((s) => `- ${s}`).join('\n')}`);
  }

  const forbiddenRules = [...recipe.forbidden];
  const negativeUnique = Array.from(new Set([...forbiddenRules, ...GENERIC_NEGATIVE]));
  const negativePrompt = negativeUnique.map((s) => `避免：${s}`).join('；') + '。';

  return {
    sourceRecipeId: recipe.id,
    compiledAt: new Date().toISOString(),
    positivePrompt: positiveParts.join('\n\n'),
    negativePrompt,
    identityConstraints,
    requiredRules: [...recipe.required],
    variableRules: [...recipe.variable],
    forbiddenRules: forbiddenRules,
    fieldValues,
  };
}

/**
 * 精简主线的提示词正文：空位判断、变量清洗、从分析结果生成建议稿。
 * 不发网络请求。
 */
import { RECIPE_FIELD_LABELS } from '../../shared/constants';
import type { VisualRecipe } from '../../shared/types';
import { TARGET_USE_OPTIONS, purposeLabel } from '../generationOptions';
import type { NodeInstance, WorkflowGraph } from './types';

export const FACTORY_PROMPT_TEMPLATE = '{{visualRecipe}}\n{{taskPurpose}}';
export const PROMPT_VARIABLES = ['{{visualRecipe}}', '{{taskPurpose}}', '{{productImages}}'] as const;
const DUMMY_PROMPT_MARKERS = ['（无分析结果）', '（未填写用途）'];

export function isVacantPrompt(text: unknown): boolean {
  let next = stripPromptVariables(String(text ?? ''));
  for (const token of DUMMY_PROMPT_MARKERS) next = next.split(token).join('');
  next = next.replace(/\s+/g, ' ').trim();
  if (!next) return true;
  return TARGET_USE_OPTIONS.some((option) => option.value === next || option.label === next);
}

export function visiblePrompt(text: unknown): string {
  const raw = String(text ?? '');
  return isVacantPrompt(raw) ? '' : raw.trim();
}

export function canAutoFillPrompt(config: Record<string, unknown> | undefined): boolean {
  if (!config) return true;
  if (config.promptEditedByUser === true) return false;
  return isVacantPrompt(config.positivePrompt);
}

export function stripPromptVariables(text: string): string {
  let next = text;
  for (const token of PROMPT_VARIABLES) next = next.split(token).join('');
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

export function bindPrompt(
  template: string,
  vars: { visualRecipe: string; taskPurpose: string; productImages: string },
): string {
  return template
    .split('{{visualRecipe}}').join(vars.visualRecipe)
    .split('{{taskPurpose}}').join(vars.taskPurpose)
    .split('{{productImages}}').join(vars.productImages);
}

export function bindAndFinalizePrompt(
  template: string,
  vars: { visualRecipe: string; taskPurpose: string; productImages: string },
): string {
  return stripPromptVariables(bindPrompt(template, vars));
}

export function describeRecipe(recipe: VisualRecipe): string {
  const lines = recipe.fields.map((f) => `${RECIPE_FIELD_LABELS[f.key] ?? f.key}：${f.value}`);
  if (recipe.required.length) lines.push(`必须保持：${recipe.required.join('；')}`);
  if (recipe.forbidden.length) lines.push(`禁止：${recipe.forbidden.join('；')}`);
  return lines.join('\n');
}

export function recipeToSuggestedPrompt(recipe: VisualRecipe, purpose = ''): string {
  const purposeKey = purpose.trim();
  const purposeLine = purposeKey
    ? `用途：${purposeLabel(purposeKey) || purposeKey}`
    : '';
  const body = describeRecipe(recipe);
  return [purposeLine, body].filter(Boolean).join('\n\n');
}

export function isVisualRecipe(value: unknown): value is VisualRecipe {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as VisualRecipe).fields) &&
    typeof (value as VisualRecipe).name === 'string'
  );
}

/** 生成节点：入边 prompt 口连着的提示词节点。 */
export function connectedPromptEditor(
  graph: WorkflowGraph,
  generateId: string,
): NodeInstance | null {
  const edge = graph.edges.find((item) => item.to.node === generateId && item.to.port === 'prompt');
  if (!edge) return null;
  const src = graph.nodes.find((node) => node.id === edge.from.node);
  if (!src) return null;
  if (src.type === 'promptEditor' || src.type === 'promptCompiler') return src;
  return null;
}

/** 生成节点：入边商品图口连着的上游节点。 */
export function connectedProductSource(
  graph: WorkflowGraph,
  generateId: string,
): NodeInstance | null {
  const edge = graph.edges.find((item) => item.to.node === generateId && item.to.port === 'products');
  if (!edge) return null;
  return graph.nodes.find((node) => node.id === edge.from.node) ?? null;
}

/** 分析节点：配方/用途出边连到的提示词节点。 */
export function promptEditorsFedBy(
  graph: WorkflowGraph,
  analyzeId: string,
): NodeInstance[] {
  const ids = new Set(
    graph.edges
      .filter((edge) => edge.from.node === analyzeId)
      .map((edge) => edge.to.node),
  );
  return graph.nodes.filter((node) => ids.has(node.id) && node.type === 'promptEditor');
}

export function promptEditorStatus(config: Record<string, unknown> | undefined): 'empty' | 'from-analysis' | 'edited' {
  if (!config || isVacantPrompt(config.positivePrompt)) return 'empty';
  if (config.promptEditedByUser === true) return 'edited';
  if (typeof config.appliedFromAnalysisAt === 'string' && config.appliedFromAnalysisAt) return 'from-analysis';
  return 'edited';
}

export function suggestedPromptPatch(suggested: string): Record<string, unknown> {
  return {
    positivePrompt: suggested,
    promptEditedByUser: false,
    appliedFromAnalysisAt: new Date().toISOString(),
  };
}

export function autoFillPromptPatch(
  config: Record<string, unknown> | undefined,
  suggested: string,
): Record<string, unknown> | null {
  if (!suggested.trim() || !canAutoFillPrompt(config)) return null;
  return suggestedPromptPatch(suggested);
}

/** 分析节点上已保存的建议稿；没有则从配方现场生成。 */
export function suggestedFromAnalyze(node: NodeInstance | null | undefined): string {
  if (!node) return '';
  const stored = String(node.config.suggestedPrompt ?? '').trim();
  if (stored) return stored;
  if (isVisualRecipe(node.config.lastRecipe)) {
    return recipeToSuggestedPrompt(node.config.lastRecipe, String(node.config.purpose ?? ''));
  }
  return '';
}

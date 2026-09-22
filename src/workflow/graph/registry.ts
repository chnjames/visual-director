/**
 * 内置节点注册表（docs/15 §4 + docs/12 §8 电商节点）。
 * 封闭集合：用户可增删实例，不能新增节点类型或替换适配器。
 * - execution='executable'：本阶段接通用执行（标准模板 / 兼容节点）。
 * - execution='planned'：可编排/校验/保存，但无适配器，发布与运行必须提示“暂不可执行”。
 *
 * 节点库分层见 LIBRARY_TIER：mainline（出厂主线）/ planned（即将支持）/ compat（旧四节点兼容）。
 */
import {
  TARGET_USE_OPTIONS,
} from '../generationOptions';
import type { NodeDefinition, PortDataType } from './types';
import {
  COMPAT_NODE_TYPES,
  EXECUTABLE_NODE_TYPES,
  MAINLINE_NODE_TYPES,
  hasNodeAdapter,
} from './adapters';

/** 端口类型是否兼容连接（输出类型 → 输入类型） */
export function isPortCompatible(outType: PortDataType, inType: PortDataType): boolean {
  if (outType === inType) return true;
  if (outType === 'GeneratedImage' && inType === 'FinalImage') return true;
  return false;
}

const EX = 'executable' as const;
const PL = 'planned' as const;

export const NODE_REGISTRY: NodeDefinition[] = [
  /* ============================ 精简核心节点 ============================ */
  {
    type: 'referenceAnalyze',
    kind: 'source',
    category: '输入',
    title: '参考图分析',
    summary: '分析参考图的构图、场景、光线与色彩，生成可采用的提示词草稿',
    inputs: [],
    outputs: [
      { portId: 'refs', label: '参考图', direction: 'out', dataType: 'ReferenceImages' },
      { portId: 'recipe', label: '视觉配方', direction: 'out', dataType: 'UnconfirmedRecipe' },
      { portId: 'purpose', label: '用途', direction: 'out', dataType: 'TaskPurpose' },
    ],
    configFields: [
      { key: 'images', label: '参考图（1–5 张）', dataType: 'image-list', defaultValue: [], inline: true },
      {
        key: 'purpose',
        label: '场景用途',
        dataType: 'select',
        defaultValue: 'main-scene',
        enumValues: TARGET_USE_OPTIONS.map((option) => option.value),
        inline: true,
      },
      { key: 'excludeSubject', label: '排除参考图中的商品主体', dataType: 'switch', defaultValue: true, inline: true },
      { key: 'analysisOutput', label: '分析结果', dataType: 'readonly-output', defaultValue: '', inline: false, group: '结果' },
      { key: 'suggestedPrompt', label: '建议提示词', dataType: 'readonly-output', defaultValue: '', inline: false, group: '结果' },
      { key: 'lastRecipe', label: '视觉配方', dataType: 'readonly-output', defaultValue: null, inline: false, group: '结果' },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'productImages',
    kind: 'source',
    category: '输入',
    title: '商品图',
    summary: '上传 1–10 张要出现在成图里的商品图。参考图只用于分析画面，不会代替这些图。',
    inputs: [],
    outputs: [{ portId: 'images', label: '商品图', direction: 'out', dataType: 'ProductImages' }],
    configFields: [
      { key: 'images', label: '商品图（1–10 张）', dataType: 'image-list', defaultValue: [], inline: true, max: 10 },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'promptEditor',
    kind: 'transform',
    category: '提示词',
    title: '提示词编辑与优化',
    summary: '编辑将送给图片模型的提示词；可从分析采用，也可让 AI 给出优化建议',
    inputs: [
      { portId: 'recipe', label: '视觉配方', direction: 'in', dataType: 'UnconfirmedRecipe' },
      { portId: 'purpose', label: '用途', direction: 'in', dataType: 'TaskPurpose' },
    ],
    outputs: [{ portId: 'prompt', label: 'Prompt', direction: 'out', dataType: 'CompiledPrompt' }],
    configFields: [
      {
        key: 'positivePrompt',
        label: '提示词',
        dataType: 'prompt-editor',
        defaultValue: '',
        inline: false,
        placeholder: '描述希望生成的画面，例如：浅色石材台面上的护肤品，柔和侧光，主体完整清晰',
      },
      { key: 'negativePrompt', label: '负面提示词', dataType: 'textarea', defaultValue: '', inline: false, group: '高级' },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'sceneGenerate',
    kind: 'generation',
    category: '生成',
    title: '商品场景生成',
    summary: '用提示词和商品图出图。商品图可在本节点上传，或从「商品图」节点连入。',
    inputs: [
      { portId: 'prompt', label: 'Prompt', direction: 'in', dataType: 'CompiledPrompt' },
      { portId: 'products', label: '商品图', direction: 'in', dataType: 'ProductImages' },
    ],
    outputs: [{ portId: 'image', label: '生成图', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [
      { key: 'productImages', label: '商品图（1–10 张，也可从上游连接）', dataType: 'image-list', defaultValue: [], inline: false },
      {
        key: 'positivePrompt',
        label: '生成提示词',
        dataType: 'prompt-editor',
        defaultValue: '',
        inline: false,
        placeholder: '描述希望生成的商品图片，例如：放在浅色石材台面上的护肤品场景图',
      },
      { key: 'negativePrompt', label: '负面提示词', dataType: 'textarea', defaultValue: '', inline: false, group: '高级' },
      {
        key: 'targetUse',
        label: '输出用途',
        dataType: 'select',
        defaultValue: 'main-scene',
        enumValues: ['main-white', 'main-scene', 'main-feature', 'detail-hero', 'detail-scene', 'detail-closeup', 'banner', 'social', 'custom'],
        inline: false,
      },
      { key: 'aspectRatio', label: '比例', dataType: 'aspect-ratio', defaultValue: '1:1', enumValues: ['1:1', '3:4', '4:3', '16:9', '9:16'], inline: false },
      { key: 'count', label: '数量', dataType: 'number', defaultValue: 1, min: 1, max: 4, inline: false },
      { key: 'resolution', label: '分辨率', dataType: 'resolution', defaultValue: '1K', enumValues: ['1K', '2K', '3K'], inline: false },
      { key: 'referenceStrength', label: '参考强度', dataType: 'slider', defaultValue: 0.5, min: 0, max: 1, step: 0.05, inline: false, group: '高级' },
      { key: 'keepIdentity', label: '保持商品身份', dataType: 'switch', defaultValue: true, inline: false, group: '高级' },
      { key: 'resultImages', label: '生成结果', dataType: 'readonly-output', defaultValue: '', inline: false, group: '结果' },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'resultGallery',
    kind: 'sink',
    category: '输出',
    title: '结果展示',
    summary: '展示工作流生成的全部图片，并写入运行记录与素材库',
    inputs: [
      { portId: 'images', label: '生成结果', direction: 'in', dataType: 'GeneratedImage', required: true, multi: true },
    ],
    outputs: [],
    configFields: [],
    removable: false,
    execution: EX,
  },

  /* ========================== 兼容与高级节点 ========================== */
  {
    type: 'auditExport',
    kind: 'sink',
    category: '输出',
    title: '验收与导出',
    summary: '【兼容】四维验收与导出合一；新主线请用「结果综合验收 + 结果定稿」',
    inputs: [
      { portId: 'image', label: '生成图', direction: 'in', dataType: 'GeneratedImage', required: true },
      { portId: 'products', label: '商品图', direction: 'in', dataType: 'ProductImages' },
    ],
    outputs: [{ portId: 'final', label: '终稿', direction: 'out', dataType: 'FinalImage' }],
    configFields: [
      { key: 'identityThreshold', label: '身份一致性阈值', dataType: 'slider', defaultValue: 0.8, min: 0, max: 1, step: 0.05, inline: false, group: '验收阈值' },
      { key: 'recipeThreshold', label: '配方一致性阈值', dataType: 'slider', defaultValue: 0.75, min: 0, max: 1, step: 0.05, inline: false, group: '验收阈值' },
      { key: 'technicalThreshold', label: '技术质量阈值', dataType: 'slider', defaultValue: 0.7, min: 0, max: 1, step: 0.05, inline: false, group: '验收阈值' },
      { key: 'auditOutput', label: '验收结果', dataType: 'readonly-output', defaultValue: '', inline: false, group: '结果' },
    ],
    removable: false,
    execution: EX,
  },

  /* ============================ 输入（完整节点库） ============================ */
  {
    type: 'referenceInput',
    kind: 'source',
    category: '输入',
    title: '参考图输入',
    summary: '上传 1–5 张决定视觉风格的参考图，并填写场景用途',
    inputs: [],
    outputs: [
      { portId: 'images', label: '参考图', direction: 'out', dataType: 'ReferenceImages' },
      { portId: 'purpose', label: '用途', direction: 'out', dataType: 'TaskPurpose' },
    ],
    configFields: [
      {
        key: 'images',
        label: '参考图（1–5 张）',
        dataType: 'image-list',
        defaultValue: [],
        inline: true,
      },
      {
        key: 'purpose',
        label: '场景用途',
        dataType: 'text',
        defaultValue: '',
        placeholder: '如：电商详情页首屏，浅色背景静物场景',
        inline: true,
        enumValues: [
          '主图 · 场景展示',
          '主图 · 白底产品',
          '主图 · 卖点/特写',
          '详情 · 首屏主视觉',
          '详情 · 使用场景',
          '详情 · 细节/规格',
        ],
      },
      {
        key: 'excludeSubject',
        label: '排除参考图中的商品主体',
        dataType: 'switch',
        defaultValue: true,
        inline: true,
      },
      { key: 'referenceStrength', label: '参考强度', dataType: 'slider', defaultValue: 0.6, min: 0, max: 1, step: 0.05, inline: false, group: '高级' },
      { key: 'sceneOnly', label: '只参考场景，不迁移商品主体', dataType: 'switch', defaultValue: true, inline: false, group: '高级' },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'productInput',
    kind: 'source',
    category: '输入',
    title: '商品图输入',
    summary: '上传同一商品 2–3 张多角度照片，决定商品身份',
    inputs: [],
    outputs: [{ portId: 'images', label: '商品图', direction: 'out', dataType: 'ProductImages' }],
    configFields: [
      { key: 'images', label: '商品多角度图', dataType: 'image-list', defaultValue: [] },
      { key: 'category', label: '商品类别', dataType: 'text', defaultValue: '', placeholder: '如：陶瓷花瓶' },
      { key: 'keepColor', label: '必须保持的颜色', dataType: 'text', defaultValue: '' },
      { key: 'keepMaterial', label: '必须保持的材质', dataType: 'text', defaultValue: '' },
      { key: 'keepStructure', label: '必须保持的结构', dataType: 'text', defaultValue: '' },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'batchProductInput',
    kind: 'source',
    category: '输入',
    title: '批量商品输入',
    summary: '为批量任务导入多组商品（每组 2–3 张），规划中',
    inputs: [],
    outputs: [{ portId: 'items', label: '商品组', direction: 'out', dataType: 'ProductImages' }],
    configFields: [{ key: 'groups', label: '商品分组', dataType: 'image-list', defaultValue: [] }],
    removable: true,
    execution: PL,
  },

  /* ============================ 理解 ============================ */
  {
    type: 'recipeExtractor',
    kind: 'analysis',
    category: '理解',
    title: '视觉配方提取',
    summary: '从参考图提取 12 个视觉字段与图像证据',
    inputs: [{ portId: 'refs', label: '参考图', direction: 'in', dataType: 'ReferenceImages', required: true }],
    outputs: [{ portId: 'recipe', label: '待确认配方', direction: 'out', dataType: 'UnconfirmedRecipe' }],
    configFields: [
      { key: 'model', label: '分析模型', dataType: 'model-selector', defaultValue: 'default', inline: false, group: '高级' },
      { key: 'extraRequirement', label: '自定义补充要求', dataType: 'textarea', defaultValue: '', inline: false, group: '高级' },
      { key: 'analysisOutput', label: '分析结果', dataType: 'readonly-output', defaultValue: '', inline: false, group: '结果' },
      { key: 'lastRecipe', label: '视觉配方', dataType: 'readonly-output', defaultValue: null, inline: false, group: '结果' },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'referenceAnalyzer',
    kind: 'analysis',
    category: '理解',
    title: '构图与光线分析',
    summary: '分析参考图的构图、光线、色彩与材质倾向（规划中）',
    inputs: [{ portId: 'refs', label: '参考图', direction: 'in', dataType: 'ReferenceImages', required: true }],
    outputs: [{ portId: 'analysis', label: '分析结论', direction: 'out', dataType: 'UnconfirmedRecipe' }],
    configFields: [],
    removable: true,
    execution: PL,
  },
  {
    type: 'promptReverse',
    kind: 'analysis',
    category: '理解',
    title: '提示词反推',
    summary: '从参考图反推出可编辑的提示词（规划中）',
    inputs: [{ portId: 'refs', label: '参考图', direction: 'in', dataType: 'ReferenceImages', required: true }],
    outputs: [{ portId: 'prompt', label: '反推提示词', direction: 'out', dataType: 'CompiledPrompt' }],
    configFields: [],
    removable: true,
    execution: PL,
  },
  {
    type: 'identityExtractor',
    kind: 'analysis',
    category: '理解',
    title: '商品身份提取',
    summary: '提出形状/部件/颜色/材质等候选，全部初始为待确认',
    inputs: [
      { portId: 'products', label: '商品图', direction: 'in', dataType: 'ProductImages', required: true },
      { portId: 'refs', label: '参考图', direction: 'in', dataType: 'ReferenceImages' },
    ],
    outputs: [{ portId: 'features', label: '候选特征', direction: 'out', dataType: 'IdentityCandidates' }],
    configFields: [
      { key: 'model', label: '身份分析模型', dataType: 'model-selector', defaultValue: 'default' },
      { key: 'protectAttrs', label: '重点保护属性', dataType: 'text', defaultValue: '形状、颜色、材质、结构、Logo' },
    ],
    removable: true,
    execution: EX,
  },

  /* ========================== 人工确认 ========================== */
  {
    type: 'recipeConfirmGate',
    kind: 'gate',
    category: '人工确认',
    title: '视觉配方确认',
    summary: '第一道人工闸门：确认迁移边界，未确认配方不得编译',
    isHumanGate: true,
    inputs: [{ portId: 'recipe', label: '待确认配方', direction: 'in', dataType: 'UnconfirmedRecipe', required: true }],
    outputs: [{ portId: 'recipe', label: '已确认配方', direction: 'out', dataType: 'VisualRecipe' }],
    configFields: [
      { key: 'confirmedRecipe', label: '已确认配方', dataType: 'readonly-output', defaultValue: null, inline: false, group: '结果' },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'identityConfirmGate',
    kind: 'gate',
    category: '人工确认',
    title: '商品身份确认',
    summary: '逐条确认或驳回候选；仅已确认项成为硬约束，跳过需自担风险',
    isHumanGate: true,
    inputs: [{ portId: 'features', label: '候选特征', direction: 'in', dataType: 'IdentityCandidates', required: true }],
    outputs: [{ portId: 'features', label: '身份硬约束', direction: 'out', dataType: 'IdentityFeatureSet' }],
    configFields: [],
    removable: true,
    execution: EX,
  },
  {
    type: 'resultConfirmGate',
    kind: 'gate',
    category: '人工确认',
    title: '结果确认',
    summary: '人工接受警告/需复核的结果（规划中）',
    isHumanGate: true,
    inputs: [{ portId: 'audit', label: '验收结论', direction: 'in', dataType: 'AuditResult', required: true }],
    outputs: [{ portId: 'image', label: '终稿', direction: 'out', dataType: 'FinalImage' }],
    configFields: [],
    removable: true,
    execution: PL,
  },

  /* =========================== 提示词 =========================== */
  {
    type: 'promptCompiler',
    kind: 'transform',
    category: '提示词',
    title: 'Prompt 编译',
    summary: '由已确认配方与身份单向编译，可编辑创意描述与负面词，不能改写事实',
    inputs: [
      { portId: 'recipe', label: '已确认配方', direction: 'in', dataType: 'VisualRecipe', required: true },
      { portId: 'features', label: '身份硬约束', direction: 'in', dataType: 'IdentityFeatureSet' },
      { portId: 'purpose', label: '用途', direction: 'in', dataType: 'TaskPurpose' },
    ],
    outputs: [{ portId: 'prompt', label: '编译后 Prompt', direction: 'out', dataType: 'CompiledPrompt' }],
    configFields: [
      {
        key: 'systemConstraints',
        label: '系统约束（只读，来自上游事实）',
        dataType: 'readonly-output',
        defaultValue: '',
        inline: false,
        group: '事实',
      },
      {
        key: 'positivePrompt',
        label: '主提示词（可编辑创意描述）',
        dataType: 'prompt-editor',
        defaultValue: '',
        inline: true,
        variables: ['{{visualRecipe}}', '{{identityFeatures}}', '{{taskPurpose}}', '{{productImages}}'],
      },
      { key: 'negativePrompt', label: '负面提示词', dataType: 'textarea', defaultValue: '', inline: false, group: '高级' },
      { key: 'preview', label: 'Prompt 预览', dataType: 'readonly-output', defaultValue: '', inline: false, group: '高级' },
    ],
    removable: false,
    execution: EX,
  },
  {
    type: 'promptOptimizer',
    kind: 'transform',
    category: '提示词',
    title: 'Prompt 优化',
    summary: '调用文本模型给出优化建议，需你确认才写回，不改写身份事实（规划中）',
    inputs: [{ portId: 'prompt', label: 'Prompt', direction: 'in', dataType: 'CompiledPrompt', required: true }],
    outputs: [{ portId: 'prompt', label: '优化后 Prompt', direction: 'out', dataType: 'CompiledPrompt' }],
    configFields: [
      { key: 'original', label: '原提示词', dataType: 'textarea', defaultValue: '' },
      { key: 'optimized', label: '优化建议', dataType: 'readonly-output', defaultValue: '' },
    ],
    removable: true,
    maxInstances: 1,
    execution: PL,
  },
  {
    type: 'negativePrompt',
    kind: 'transform',
    category: '提示词',
    title: '负面提示词',
    summary: '集中维护不希望出现的元素（规划中）',
    inputs: [{ portId: 'prompt', label: 'Prompt', direction: 'in', dataType: 'CompiledPrompt' }],
    outputs: [{ portId: 'prompt', label: '增强后 Prompt', direction: 'out', dataType: 'CompiledPrompt' }],
    configFields: [{ key: 'negative', label: '负面约束', dataType: 'textarea', defaultValue: '' }],
    removable: true,
    execution: PL,
  },
  {
    type: 'styleConstraint',
    kind: 'transform',
    category: '提示词',
    title: '风格约束',
    summary: '附加光线、镜头、色彩风格约束（规划中）',
    inputs: [{ portId: 'prompt', label: 'Prompt', direction: 'in', dataType: 'CompiledPrompt' }],
    outputs: [{ portId: 'prompt', label: '约束后 Prompt', direction: 'out', dataType: 'CompiledPrompt' }],
    configFields: [{ key: 'style', label: '风格', dataType: 'text', defaultValue: '' }],
    removable: true,
    execution: PL,
  },

  /* ============================ 生成 ============================ */
  {
    type: 'sceneGenerator',
    kind: 'generation',
    category: '生成',
    title: '商品场景生成',
    summary: '按编译后的 Prompt 生成静物商品场景图',
    inputs: [{ portId: 'prompt', label: '编译后 Prompt', direction: 'in', dataType: 'CompiledPrompt', required: true }],
    outputs: [{ portId: 'image', label: '生成图', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [
      { key: 'model', label: '图片模型', dataType: 'model-selector', defaultValue: 'default' },
      { key: 'aspectRatio', label: '比例', dataType: 'aspect-ratio', defaultValue: '1:1', enumValues: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
      { key: 'resolution', label: '分辨率', dataType: 'resolution', defaultValue: '1K', enumValues: ['1K', '2K', '3K'] },
      { key: 'count', label: '生成数量', dataType: 'number', defaultValue: 1, min: 1, max: 4 },
      { key: 'referenceStrength', label: '参考强度', dataType: 'slider', defaultValue: 0.5, min: 0, max: 1, step: 0.05 },
      { key: 'styleStrength', label: '风格强度', dataType: 'slider', defaultValue: 0.5, min: 0, max: 1, step: 0.05 },
      { key: 'seed', label: 'Seed（可选）', dataType: 'number', defaultValue: '' },
      { key: 'keepIdentity', label: '保持商品身份', dataType: 'switch', defaultValue: true },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'similarGenerator',
    kind: 'generation',
    category: '生成',
    title: '参考图相似生成',
    summary: '沿用参考图视觉语言生成不照抄的相似图（规划中）',
    inputs: [
      { portId: 'prompt', label: 'Prompt', direction: 'in', dataType: 'CompiledPrompt' },
      { portId: 'refs', label: '参考图', direction: 'in', dataType: 'ReferenceImages' },
    ],
    outputs: [{ portId: 'image', label: '生成图', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [{ key: 'similarity', label: '相似度', dataType: 'slider', defaultValue: 0.5, min: 0, max: 1, step: 0.05 }],
    removable: true,
    execution: PL,
  },
  {
    type: 'batchGenerator',
    kind: 'generation',
    category: '生成',
    title: '批量生成',
    summary: '用同一已发布工作流批量生成（规划中，批量页提供执行）',
    inputs: [
      { portId: 'items', label: '商品组', direction: 'in', dataType: 'ProductImages', required: true },
      { portId: 'prompt', label: 'Prompt', direction: 'in', dataType: 'CompiledPrompt', required: true },
    ],
    outputs: [{ portId: 'images', label: '批量结果', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [],
    removable: true,
    execution: PL,
  },

  /* ========================== 图像处理 ========================== */
  {
    type: 'backgroundRemove',
    kind: 'transform',
    category: '图像处理',
    title: '背景移除',
    summary: '抠出商品主体（规划中）',
    inputs: [{ portId: 'image', label: '图片', direction: 'in', dataType: 'GeneratedImage', required: true }],
    outputs: [{ portId: 'image', label: '处理后图片', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [],
    removable: true,
    execution: PL,
  },
  {
    type: 'backgroundReplace',
    kind: 'transform',
    category: '图像处理',
    title: '背景替换',
    summary: '替换场景背景，保持商品（规划中）',
    inputs: [{ portId: 'image', label: '图片', direction: 'in', dataType: 'GeneratedImage', required: true }],
    outputs: [{ portId: 'image', label: '处理后图片', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [{ key: 'background', label: '背景描述', dataType: 'text', defaultValue: '' }],
    removable: true,
    execution: PL,
  },
  {
    type: 'outpaint',
    kind: 'transform',
    category: '图像处理',
    title: '图片扩展',
    summary: '向外扩展画布（规划中）',
    inputs: [{ portId: 'image', label: '图片', direction: 'in', dataType: 'GeneratedImage', required: true }],
    outputs: [{ portId: 'image', label: '扩展后图片', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [{ key: 'ratio', label: '目标比例', dataType: 'aspect-ratio', defaultValue: '4:3' }],
    removable: true,
    execution: PL,
  },
  {
    type: 'enhance',
    kind: 'transform',
    category: '图像处理',
    title: '图片增强',
    summary: '清晰度、光影增强（规划中）',
    inputs: [{ portId: 'image', label: '图片', direction: 'in', dataType: 'GeneratedImage', required: true }],
    outputs: [{ portId: 'image', label: '增强后图片', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [],
    removable: true,
    execution: PL,
  },
  {
    type: 'inpaint',
    kind: 'transform',
    category: '图像处理',
    title: '局部重绘',
    summary: '对选定区域重绘（规划中）',
    inputs: [{ portId: 'image', label: '图片', direction: 'in', dataType: 'GeneratedImage', required: true }],
    outputs: [{ portId: 'image', label: '重绘后图片', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [{ key: 'maskPrompt', label: '重绘描述', dataType: 'text', defaultValue: '' }],
    removable: true,
    execution: PL,
  },
  {
    type: 'platformFit',
    kind: 'transform',
    category: '图像处理',
    title: '尺寸/平台适配',
    summary: '裁剪适配各电商平台尺寸（规划中）',
    inputs: [{ portId: 'image', label: '图片', direction: 'in', dataType: 'GeneratedImage', required: true }],
    outputs: [{ portId: 'image', label: '适配后图片', direction: 'out', dataType: 'GeneratedImage' }],
    configFields: [{ key: 'platform', label: '平台', dataType: 'select', defaultValue: '主图1:1', enumValues: ['主图1:1', '详情3:4', '横幅16:9'] }],
    removable: true,
    execution: PL,
  },

  /* ============================ 验收 ============================ */
  {
    type: 'resultAuditor',
    kind: 'audit',
    category: '验收',
    title: '结果综合验收',
    summary: '身份 40% / 配方 30% / 任务 20% / 技术 10%，严重问题一票否决',
    inputs: [
      { portId: 'image', label: '生成图', direction: 'in', dataType: 'GeneratedImage', required: true },
      { portId: 'products', label: '商品图', direction: 'in', dataType: 'ProductImages' },
      { portId: 'recipe', label: '已确认配方', direction: 'in', dataType: 'VisualRecipe' },
    ],
    outputs: [{ portId: 'audit', label: '验收结论', direction: 'out', dataType: 'AuditResult' }],
    configFields: [
      { key: 'identityThreshold', label: '身份一致性阈值', dataType: 'slider', defaultValue: 0.8, min: 0, max: 1, step: 0.05 },
      { key: 'recipeThreshold', label: '配方一致性阈值', dataType: 'slider', defaultValue: 0.75, min: 0, max: 1, step: 0.05 },
      { key: 'technicalThreshold', label: '技术质量阈值', dataType: 'slider', defaultValue: 0.7, min: 0, max: 1, step: 0.05 },
      { key: 'criticalVeto', label: '严重问题一票否决', dataType: 'switch', defaultValue: true },
      { key: 'needHuman', label: '警告需人工确认', dataType: 'switch', defaultValue: true },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'identityAuditor',
    kind: 'audit',
    category: '验收',
    title: '商品身份一致性检查',
    summary: '只检查商品身份是否保持（规划中）',
    inputs: [
      { portId: 'image', label: '生成图', direction: 'in', dataType: 'GeneratedImage', required: true },
      { portId: 'products', label: '商品图', direction: 'in', dataType: 'ProductImages', required: true },
    ],
    outputs: [{ portId: 'audit', label: '检查结论', direction: 'out', dataType: 'AuditResult' }],
    configFields: [],
    removable: true,
    execution: PL,
  },
  {
    type: 'recipeAuditor',
    kind: 'audit',
    category: '验收',
    title: '视觉配方一致性检查',
    summary: '只检查构图/光线/色彩是否符合配方（规划中）',
    inputs: [
      { portId: 'image', label: '生成图', direction: 'in', dataType: 'GeneratedImage', required: true },
      { portId: 'recipe', label: '配方', direction: 'in', dataType: 'VisualRecipe', required: true },
    ],
    outputs: [{ portId: 'audit', label: '检查结论', direction: 'out', dataType: 'AuditResult' }],
    configFields: [],
    removable: true,
    execution: PL,
  },
  {
    type: 'technicalAuditor',
    kind: 'audit',
    category: '验收',
    title: '技术质量检查',
    summary: '清晰度、畸变、伪影检查（规划中）',
    inputs: [{ portId: 'image', label: '生成图', direction: 'in', dataType: 'GeneratedImage', required: true }],
    outputs: [{ portId: 'audit', label: '检查结论', direction: 'out', dataType: 'AuditResult' }],
    configFields: [],
    removable: true,
    execution: PL,
  },

  /* ============================ 输出 ============================ */
  {
    type: 'targetedRepair',
    kind: 'repair',
    category: '输出',
    title: '定向修复',
    summary: '验收失败时给受限补丁并重生；高风险必须人工确认，每件最多一次',
    maxInstances: 1,
    inputs: [
      { portId: 'audit', label: '失败验收', direction: 'in', dataType: 'AuditResult', required: true },
      { portId: 'prompt', label: '编译后 Prompt', direction: 'in', dataType: 'CompiledPrompt', required: true },
    ],
    outputs: [{ portId: 'patch', label: '修复补丁', direction: 'out', dataType: 'RepairPatch' }],
    configFields: [
      { key: 'maxRepairs', label: '最大修复次数', dataType: 'number', defaultValue: 1, min: 1, max: 1 },
      { key: 'allowScope', label: '允许修改范围', dataType: 'text', defaultValue: '场景、光线、背景、构图、负面约束' },
      { key: 'forbidFacts', label: '禁止修改的商品事实', dataType: 'text', defaultValue: '已确认配方、商品身份、颜色、材质、结构、Logo' },
      { key: 'highRiskConfirm', label: '高风险修改必须确认', dataType: 'switch', defaultValue: true },
    ],
    removable: true,
    execution: EX,
  },
  {
    type: 'finalSink',
    kind: 'sink',
    category: '输出',
    title: '结果定稿',
    summary: '接受通过或人工确认的结果作为终稿（版本与下载）',
    inputs: [
      { portId: 'image', label: '终稿图', direction: 'in', dataType: 'FinalImage', required: true, multi: true },
      { portId: 'audit', label: '验收结论', direction: 'in', dataType: 'AuditResult' },
    ],
    outputs: [],
    configFields: [],
    removable: false,
    execution: EX,
  },
];

const REGISTRY_MAP = new Map(NODE_REGISTRY.map((d) => [d.type, d]));

// execution 由适配器目录派生。定义中的旧值只服务源码可读性，运行时不采信。
for (const definition of NODE_REGISTRY) {
  definition.execution = hasNodeAdapter(definition.type) ? EX : PL;
}

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return REGISTRY_MAP.get(type);
}

export function requireNodeDefinition(type: string): NodeDefinition {
  const def = REGISTRY_MAP.get(type);
  if (!def) throw new Error(`未知节点类型：${type}`);
  return def;
}

export function findPortDef(def: NodeDefinition, nodeSide: 'in' | 'out', portId: string) {
  return (nodeSide === 'in' ? def.inputs : def.outputs).find((p) => p.portId === portId);
}

export { COMPAT_NODE_TYPES, EXECUTABLE_NODE_TYPES, MAINLINE_NODE_TYPES };

export type LibraryTier = 'mainline' | 'planned' | 'compat';

export function libraryTierOf(type: string): LibraryTier {
  if (MAINLINE_NODE_TYPES.has(type)) return 'mainline';
  if (COMPAT_NODE_TYPES.has(type)) return 'compat';
  return 'planned';
}

export const LIBRARY_TIER_LABELS: Record<LibraryTier, string> = {
  mainline: '可执行 · 主线',
  planned: '即将支持',
  compat: '兼容保留',
};

/**
 * 出厂模板：参考图辅助生成。
 * 参考图分析 → 提示词编辑与优化 → 商品场景生成 → 结果展示，
 * 商品图从左侧单独接入生成节点。
 */
import type { Edge, NodeInstance, WorkflowGraph } from './types';
import { requireNodeDefinition } from './registry';

export const STANDARD_TEMPLATE_ID = 'standard-still-life';

export const NODE_W = 280;
export const NODE_H = 140;

const X = [40, 360, 680, 1000];
const Y0 = 72;
const Y1 = 460;

export function standardTemplateGraph(): WorkflowGraph {
  const nodes: NodeInstance[] = [
    n('referenceAnalyze', X[0], Y0),
    n('productImages', X[0], Y1),
    n('promptEditor', X[1], Y0),
    n('sceneGenerate', X[2], Y0),
    n('resultGallery', X[3], Y0),
  ];
  const byType = new Map(nodes.map((x) => [x.type, x]));
  const id = (t: string) => byType.get(t)!.id;

  const edges: Edge[] = [
    e(id('referenceAnalyze'), 'recipe', id('promptEditor'), 'recipe'),
    e(id('referenceAnalyze'), 'purpose', id('promptEditor'), 'purpose'),
    e(id('promptEditor'), 'prompt', id('sceneGenerate'), 'prompt'),
    e(id('productImages'), 'images', id('sceneGenerate'), 'products'),
    e(id('sceneGenerate'), 'image', id('resultGallery'), 'images'),
  ];

  return { nodes, edges };
}

/** 旧 11 节点流程仅供历史版本与兼容回归测试，不再出现在新建模板。 */
export function advancedCompatibilityTemplateGraph(): WorkflowGraph {
  const x = [40, 320, 600, 880, 1160, 1440, 1720, 2000];
  const y1 = 340;
  const nodes: NodeInstance[] = [
    n('referenceInput', x[0], Y0),
    n('recipeExtractor', x[1], Y0),
    n('recipeConfirmGate', x[2], Y0),
    n('promptCompiler', x[3], Y0),
    n('sceneGenerator', x[4], Y0),
    n('resultAuditor', x[5], Y0),
    n('targetedRepair', x[6], Y0),
    n('finalSink', x[7], Y0),
    n('productInput', x[0], y1),
    n('identityExtractor', x[1], y1),
    n('identityConfirmGate', x[2], y1),
  ];
  const byType = new Map(nodes.map((node) => [node.type, node]));
  const id = (type: string) => byType.get(type)!.id;
  return {
    nodes,
    edges: [
      e(id('referenceInput'), 'images', id('recipeExtractor'), 'refs'),
      e(id('referenceInput'), 'images', id('identityExtractor'), 'refs'),
      e(id('referenceInput'), 'purpose', id('promptCompiler'), 'purpose'),
      e(id('recipeExtractor'), 'recipe', id('recipeConfirmGate'), 'recipe'),
      e(id('recipeConfirmGate'), 'recipe', id('promptCompiler'), 'recipe'),
      e(id('productInput'), 'images', id('identityExtractor'), 'products'),
      e(id('identityExtractor'), 'features', id('identityConfirmGate'), 'features'),
      e(id('identityConfirmGate'), 'features', id('promptCompiler'), 'features'),
      e(id('promptCompiler'), 'prompt', id('sceneGenerator'), 'prompt'),
      e(id('sceneGenerator'), 'image', id('resultAuditor'), 'image'),
      e(id('productInput'), 'images', id('resultAuditor'), 'products'),
      e(id('recipeConfirmGate'), 'recipe', id('resultAuditor'), 'recipe'),
      e(id('resultAuditor'), 'audit', id('targetedRepair'), 'audit'),
      e(id('promptCompiler'), 'prompt', id('targetedRepair'), 'prompt'),
      e(id('sceneGenerator'), 'image', id('finalSink'), 'image'),
      e(id('resultAuditor'), 'audit', id('finalSink'), 'audit'),
    ],
  };
}

/** 历史四节点模板（仅兼容/测试用，不再作为新建默认） */
export function legacyFourNodeTemplateGraph(): WorkflowGraph {
  const nodes: NodeInstance[] = [
    n('referenceAnalyze', X[0], Y0),
    n('promptEditor', X[1], Y0),
    n('sceneGenerate', X[2], Y0),
    n('auditExport', X[3], Y0),
  ];
  const byType = new Map(nodes.map((x) => [x.type, x]));
  const id = (t: string) => byType.get(t)!.id;
  return {
    nodes,
    edges: [
      e(id('referenceAnalyze'), 'recipe', id('promptEditor'), 'recipe'),
      e(id('referenceAnalyze'), 'purpose', id('promptEditor'), 'purpose'),
      e(id('promptEditor'), 'prompt', id('sceneGenerate'), 'prompt'),
      e(id('sceneGenerate'), 'image', id('auditExport'), 'image'),
    ],
  };
}

let seq = 0;
function nid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

function n(type: string, x: number, y: number): NodeInstance {
  const definition = requireNodeDefinition(type);
  return {
    id: nid('n'),
    type,
    position: { x, y },
    config: Object.fromEntries(
      definition.configFields.map((field) => [
        field.key,
        JSON.parse(JSON.stringify(field.defaultValue)),
      ]),
    ),
  };
}

function e(
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
): Edge {
  return {
    id: nid('e'),
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
  };
}

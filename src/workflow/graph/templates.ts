/**
 * 工作流模板（docs/11 新建项目）。
 * 数据驱动：每个模板只是“图 + 元数据”，创建项目时深拷贝为独立 Draft，
 * 后续编辑不影响模板源。模板不写在 React 页面里。
 */
import { standardTemplateGraph } from './template';
import { requireNodeDefinition } from './registry';
import type { WorkflowGraph } from './types';

export type WorkflowTemplate = {
  id: string;
  name: string;
  tagline: string; // 一句话用途
  fitFor: string; // 适合场景
  /** 主要节点类型（卡片预览，按顺序） */
  nodeKinds: string[];
  buildGraph: () => WorkflowGraph;
  /** 空白模板标记：只给最小开始/结果或完全空 */
  blank?: boolean;
};

let uid = 0;
function id(prefix: string) {
  uid += 1;
  return `${prefix}_t${uid}_${Math.random().toString(36).slice(2, 7)}`;
}

function node(type: string, x: number, y: number) {
  const definition = requireNodeDefinition(type);
  return {
    id: id('n'),
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
function edge(a: { id: string }, ap: string, b: { id: string }, bp: string) {
  return { id: id('e'), from: { node: a.id, port: ap }, to: { node: b.id, port: bp } };
}

const X = [40, 360];
const Y0 = 60;

/** 最短可用闭环：生成节点直接持有商品图与提示词。 */
function directGraph(): WorkflowGraph {
  const generate = node('sceneGenerate', X[0], Y0);
  const gallery = node('resultGallery', X[1], Y0);
  return {
    nodes: [generate, gallery],
    edges: [edge(generate, 'image', gallery, 'images')],
  };
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'blank',
    name: '直接生成',
    tagline: '上传商品图、填写提示词并直接生成多张图片',
    fitFor: '已有明确创意方向，希望快速出图',
    nodeKinds: ['sceneGenerate', 'resultGallery'],
    buildGraph: directGraph,
  },
  {
    id: 'standard-still-life',
    name: '参考图辅助生成',
    tagline: '参考图决定画面，商品图决定主体，分析后再生成',
    fitFor: '已有目标视觉参考，也有要放进画面的商品图',
    nodeKinds: ['referenceAnalyze', 'productImages', 'promptEditor', 'sceneGenerate', 'resultGallery'],
    buildGraph: standardTemplateGraph,
  },
];

export function getTemplate(id: string): WorkflowTemplate {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id) ?? WORKFLOW_TEMPLATES[1];
}

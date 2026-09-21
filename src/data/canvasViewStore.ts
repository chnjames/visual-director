/**
 * 每项目画布视口与节点布局（docs/12 §6：800ms 防抖自动保存、刷新恢复）。
 * 与业务工作流严格分离：这里只存“怎么看”，不存任何模型/配方事实。
 */
import { canvasViewKey } from './db';
import type { WorkflowNodeId } from '../workflow/workflowConstants';

export type NodePositions = Partial<Record<WorkflowNodeId, { x: number; y: number }>>;

export type CanvasView = {
  schemaVersion: 1;
  /** 视口平移（世界坐标） */
  pan: { x: number; y: number };
  /** 缩放 0.2–2.5 */
  zoom: number;
  nodePositions: NodePositions;
  selectedNodeId?: WorkflowNodeId | null;
  updatedAt: string;
};

export const DEFAULT_CANVAS_VIEW: Omit<CanvasView, 'updatedAt'> = {
  schemaVersion: 1,
  pan: { x: 0, y: 0 },
  zoom: 1,
  nodePositions: {},
  selectedNodeId: null,
};

export async function loadCanvasView(projectId: string): Promise<CanvasView | null> {
  const raw = (await canvasViewKey(projectId).load((d) => d as CanvasView)) as CanvasView | null;
  if (!raw || raw.schemaVersion !== 1) return null;
  return raw;
}

export async function saveCanvasView(projectId: string, view: CanvasView): Promise<void> {
  await canvasViewKey(projectId).enqueue(view as unknown);
}

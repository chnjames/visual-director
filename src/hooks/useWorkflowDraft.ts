/**
 * 工作流草稿编辑状态（docs/12 交互 + docs/15 图模型）。
 *
 * 职责：
 * - 装载/保存项目草稿（复用 PersistedKey 串行写）；
 * - 维护图、选择态、视口、历史（撤销/重做）；
 * - 实时校验结果；800ms 防抖自动保存。
 * 不负责：模型执行（本阶段节点 execution='planned'）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, GraphValidationResult, NodeInstance, WorkflowDraft, WorkflowGraph } from '../workflow/graph/types';
import { validateGraph, canConnect } from '../workflow/graph/validate';
import {
  addNode as opAdd,
  autoLayout as opAutoLayout,
  connect as opConnect,
  duplicateNode as opDuplicate,
  fitBounds,
  moveNode as opMove,
  removeEdge as opRemoveEdge,
  removeNode as opRemove,
  updateNodeConfig as opUpdateConfig,
  updateNodeConfigs as opUpdateConfigs,
} from '../workflow/graph/graphOps';
import { GraphHistory } from '../workflow/graph/history';
import { loadDraft, saveDraft } from '../data/draftStore';
import { indexNodeImagesToAssets } from '../data/indexNodeImages';
import {
  loadCanvasView,
  saveCanvasView,
  DEFAULT_CANVAS_VIEW,
  type CanvasView,
} from '../data/canvasViewStore';

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | null;

export type ConnectResult = { ok: true } | { ok: false; reason: string };

const EMPTY_VALIDATION: GraphValidationResult = {
  errors: [],
  warnings: [],
  hints: [],
  isAcyclic: true,
  canPublish: false,
};

export function useWorkflowDraft(projectId: string, projectName: string) {
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [validation, setValidation] = useState<GraphValidationResult>(EMPTY_VALIDATION);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [view, setView] = useState<CanvasView>({
    ...DEFAULT_CANVAS_VIEW,
    updatedAt: new Date().toISOString(),
  });
  const [historyVersion, setHistoryVersion] = useState({ undo: false, redo: false, undoCount: 0 });

  const historyRef = useRef<GraphHistory | null>(null);
  const draftRef = useRef<WorkflowDraft | null>(null);
  const saveTimer = useRef<number | null>(null);
  const viewSaveTimer = useRef<number | null>(null);
  const skipFirstSave = useRef(true);
  const viewRef = useRef(view);
  viewRef.current = view;

  // 装载草稿与视口。项目切换时完整重置，避免残留 selection/pan/zoom/定时器。
  useEffect(() => {
    let alive = true;
    skipFirstSave.current = true;
    setDraft(null);
    setSelection(null);
    setValidation(EMPTY_VALIDATION);
    setSaveState('idle');
    setSavedAt(null);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    const defaultView: CanvasView = { ...DEFAULT_CANVAS_VIEW, updatedAt: new Date().toISOString() };
    viewRef.current = defaultView;
    setView(defaultView);

    void Promise.all([loadDraft(projectId, projectName), loadCanvasView(projectId)]).then(
      ([d, v]) => {
        if (!alive) return;
        draftRef.current = d;
        historyRef.current = new GraphHistory(d.graph);
        setDraft(d);
        setValidation(validateGraph(d.graph));
        syncHistoryFlags();
        if (v) {
          const restored: CanvasView = {
            ...DEFAULT_CANVAS_VIEW,
            pan: v.pan,
            zoom: v.zoom,
            nodePositions: v.nodePositions ?? {},
            selectedNodeId: v.selectedNodeId ?? null,
            updatedAt: new Date().toISOString(),
          };
          viewRef.current = restored;
          setView(restored);
        }
      },
    );
    return () => {
      alive = false;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function syncHistoryFlags() {
    const h = historyRef.current;
    setHistoryVersion({
      undo: !!h?.canUndo,
      redo: !!h?.canRedo,
      undoCount: h?.undoCount ?? 0,
    });
  }

  /** 提交一次产生历史点的编辑 */
  const commit = useCallback((nextGraph: WorkflowGraph) => {
    const h = historyRef.current;
    const cur = draftRef.current;
    if (!h || !cur) return;
    h.commit(nextGraph);
    const next = { ...cur, graph: h.current };
    draftRef.current = next;
    setDraft(next);
    setValidation(validateGraph(nextGraph));
    syncHistoryFlags();
    scheduleSave(next);
  }, []);

  /** 拖动过程中的临时更新（不产生历史点，不保存，松手再 commit） */
  const transientMove = useCallback((nodeId: string, position: { x: number; y: number }) => {
    const h = historyRef.current;
    const cur = draftRef.current;
    if (!h || !cur) return;
    const next = opMove(h.current, nodeId, position);
    if (next === h.current) return;
    h.replaceTransient(next);
    setDraft({ ...cur, graph: next });
  }, []);

  const endMove = useCallback(() => {
    const h = historyRef.current;
    const cur = draftRef.current;
    if (!h || !cur) return;
    // 与上一历史点相同则回退，否则固化
    const next = h.current;
    commit(next);
  }, [commit]);

  const scheduleSave = useCallback((d: WorkflowDraft) => {
    if (skipFirstSave.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setSaveState('saving');
    pendingSaveRef.current = d;
    saveTimer.current = window.setTimeout(() => {
      void flushSave();
    }, 800);
  }, []);

  const pendingSaveRef = useRef<WorkflowDraft | null>(null);
  const flushSave = useCallback(async () => {
    const d = pendingSaveRef.current;
    if (!d) return;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      const status = await saveDraft(d);
      if (status === 'failed') {
        setSaveState('failed');
        return;
      }
      pendingSaveRef.current = null;
      setSaveState('saved');
      setSavedAt(Date.now());
    } catch {
      setSaveState('failed');
    }
  }, []);

  // 卸载/切项目前：若有未落盘修改，最后保存一次，避免“最后一次修改丢失”
  useEffect(() => {
    return () => {
      if (pendingSaveRef.current) void saveDraft(pendingSaveRef.current);
    };
  }, []);

  useEffect(() => {
    // 首次装载完成后再允许保存
    if (draft) skipFirstSave.current = false;
  }, [draft]);

  const scheduleViewSave = useCallback((v: CanvasView) => {
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    viewSaveTimer.current = window.setTimeout(() => {
      void saveCanvasView(projectId, v);
    }, 800);
  }, [projectId]);

  const patchView = useCallback(
    (patch: Partial<CanvasView>) => {
      const next = { ...viewRef.current, ...patch, updatedAt: new Date().toISOString() };
      viewRef.current = next;
      setView(next);
      scheduleViewSave(next);
    },
    [scheduleViewSave],
  );

  /* --------------------------- 编辑动作 --------------------------- */

  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }, configOverrides?: Record<string, unknown>) => {
      const h = historyRef.current;
      if (!h) return null;
      const pos = position ?? screenToWorldCenter(viewRef.current);
      try {
        const nextGraph = opAdd(h.current, type, pos, configOverrides);
        commit(nextGraph);
        const created = nextGraph.nodes[nextGraph.nodes.length - 1];
        setSelection({ kind: 'node', id: created.id });
        return created.id;
      } catch (e) {
        console.warn((e as Error).message);
        return null;
      }
    },
    [commit],
  );

  /** 更新节点配置（进历史/触发保存/参与校验） */
  const updateNodeConfig = useCallback(
    (nodeId: string, key: string, value: unknown) => {
      const h = historyRef.current;
      if (!h) return;
      const node = h.current.nodes.find((item) => item.id === nodeId);
      commit(opUpdateConfig(h.current, nodeId, key, value));
      if (node) {
        void indexNodeImagesToAssets({
          projectId,
          nodeId,
          nodeType: node.type,
          patch: { [key]: value },
        });
      }
    },
    [commit, projectId],
  );

  /** 一次写入多个配置键（单条历史） */
  const updateNodeConfigs = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      const h = historyRef.current;
      if (!h) return;
      const node = h.current.nodes.find((item) => item.id === nodeId);
      commit(opUpdateConfigs(h.current, nodeId, patch));
      if (node) {
        void indexNodeImagesToAssets({
          projectId,
          nodeId,
          nodeType: node.type,
          patch,
        });
      }
    },
    [commit, projectId],
  );

  const removeSelected = useCallback(() => {
    const h = historyRef.current;
    if (!h || !selection) return;
    if (selection.kind === 'node') {
      try {
        commit(opRemove(h.current, selection.id));
      } catch (e) {
        console.warn((e as Error).message);
        return;
      }
    } else {
      commit(opRemoveEdge(h.current, selection.id));
    }
    setSelection(null);
  }, [commit, selection]);

  const duplicateSelected = useCallback(() => {
    const h = historyRef.current;
    if (!h || selection?.kind !== 'node') return;
    try {
      const next = opDuplicate(h.current, selection.id);
      commit(next);
      const copy = next.nodes[next.nodes.length - 1];
      setSelection({ kind: 'node', id: copy.id });
    } catch (e) {
      console.warn((e as Error).message);
    }
  }, [commit, selection]);

  const tryConnect = useCallback(
    (fromNode: string, fromPort: string, toNode: string, toPort: string): ConnectResult => {
      const h = historyRef.current;
      if (!h) return { ok: false, reason: '工作流尚未加载' };
      const reason = canConnect(h.current, fromNode, fromPort, toNode, toPort);
      if (reason) return { ok: false, reason };
      commit(opConnect(h.current, fromNode, fromPort, toNode, toPort));
      return { ok: true };
    },
    [commit],
  );

  const undo = useCallback(() => {
    const h = historyRef.current;
    const cur = draftRef.current;
    if (!h || !cur || !h.canUndo) return;
    const g = h.undo();
    const next = { ...cur, graph: g };
    draftRef.current = next;
    setDraft(next);
    setValidation(validateGraph(g));
    syncHistoryFlags();
    scheduleSave(next);
  }, [scheduleSave]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    const cur = draftRef.current;
    if (!h || !cur || !h.canRedo) return;
    const g = h.redo();
    const next = { ...cur, graph: g };
    draftRef.current = next;
    setDraft(next);
    setValidation(validateGraph(g));
    syncHistoryFlags();
    scheduleSave(next);
  }, [scheduleSave]);

  const layout = useCallback(() => {
    const h = historyRef.current;
    if (!h) return;
    commit(opAutoLayout(h.current));
  }, [commit]);

  const fit = useCallback(
    (viewport: { width: number; height: number }) => {
      const h = historyRef.current;
      if (!h) return;
      const b = fitBounds(h.current, viewport);
      patchView({ pan: b.pan, zoom: b.zoom });
    },
    [patchView],
  );

  const selectNode = useCallback((id: string | null) => {
    setSelection(id ? { kind: 'node', id } : null);
  }, []);

  const selectedNode: NodeInstance | null = useMemo(() => {
    if (!draft || selection?.kind !== 'node') return null;
    return draft.graph.nodes.find((n) => n.id === selection.id) ?? null;
  }, [draft, selection]);

  const selectedEdge: Edge | null = useMemo(() => {
    if (!draft || selection?.kind !== 'edge') return null;
    return draft.graph.edges.find((e) => e.id === selection.id) ?? null;
  }, [draft, selection]);

  // 警告涉及的节点（如删除身份闸门/验收/修复）：把全局警告关联到相关节点
  const warningNodeIds = useMemo(() => {
    const s = new Set<string>();
    if (!draft) return s;
    const hasIdentity = draft.graph.nodes.some((n) => n.type === 'identityConfirmGate');
    if (!hasIdentity) {
      draft.graph.nodes
        .filter((n) => n.type === 'sceneGenerator' || n.type === 'sceneGenerate' || n.type === 'similarGenerator' || n.type === 'promptCompiler' || n.type === 'promptEditor')
        .forEach((n) => s.add(n.id));
    }
    const hasAudit = draft.graph.nodes.some((n) => n.type === 'resultAuditor');
    if (!hasAudit) {
      draft.graph.nodes.filter((n) => n.type === 'finalSink' || n.type === 'auditExport').forEach((n) => s.add(n.id));
    }
    return s;
  }, [draft]);

  // 规划中（无真实适配器）节点类型集合
  const plannedNodeTypes = useMemo(() => {
    const s = new Set<string>();
    if (!draft) return s;
    for (const n of draft.graph.nodes) {
      if (PLANNED_NODE_TYPES.has(n.type)) s.add(n.type);
    }
    return s;
  }, [draft]);

  return {
    ready: !!draft,
    draft,
    graph: draft?.graph ?? null,
    selection,
    selectedNode,
    selectedEdge,
    validation,
    view,
    saveState,
    savedAt,
    canUndo: historyVersion.undo,
    canRedo: historyVersion.redo,
    undoCount: historyVersion.undoCount,
    warningNodeIds,
    plannedNodeTypes,
    setSelection,
    selectNode,
    addNode,
    updateNodeConfig,
    updateNodeConfigs,
    removeSelected,
    duplicateSelected,
    tryConnect,
    transientMove,
    endMove,
    undo,
    redo,
    layout,
    fit,
    patchView,
  };
}

/** 规划中节点：可编排/校验/保存，但本阶段没有执行适配器（发布与运行会提示） */
export const PLANNED_NODE_TYPES = new Set<string>([
  'batchProductInput',
  'referenceAnalyzer',
  'promptReverse',
  'promptOptimizer',
  'negativePrompt',
  'styleConstraint',
  'similarGenerator',
  'batchGenerator',
  'backgroundRemove',
  'backgroundReplace',
  'outpaint',
  'enhance',
  'inpaint',
  'platformFit',
  'identityAuditor',
  'recipeAuditor',
  'technicalAuditor',
  'resultConfirmGate',
]);

function screenToWorldCenter(view: CanvasView): { x: number; y: number } {
  // 新节点放在当前视口中心附近（世界坐标），由调用处补 viewport 中心
  return {
    x: Math.round((320 - view.pan.x) / view.zoom),
    y: Math.round((200 - view.pan.y) / view.zoom),
  };
}

void screenToWorldCenter;

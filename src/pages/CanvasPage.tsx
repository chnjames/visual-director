import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowNodeId } from '../workflow/workflowConstants';
import { useCanvasWorkflow } from '../hooks/useCanvasWorkflow';
import {
  DEFAULT_CANVAS_VIEW,
  loadCanvasView,
  saveCanvasView,
  type CanvasView,
} from '../data/canvasViewStore';
import { NodeLibrary } from '../components/canvas/NodeLibrary';
import { FlowCanvas, type FlowCanvasHandle } from '../components/canvas/FlowCanvas';
import { InspectorPanel } from '../components/canvas/InspectorPanel';
import { RunDrawer } from '../components/canvas/RunDrawer';
import { updateProject } from '../data/projectStore';
import type { ModelSettings } from '../shared/types';

/**
 * 视觉工作台（docs/12 全节）：
 * 节点库 / 无限画布 / 检查器 / 运行抽屉，全部挂在 100vh App Shell 内。
 * 业务事实来自单件工作流（经状态机），画布视图（pan/zoom/位置/选中）单独防抖持久化。
 */
export function CanvasPage({
  projectId,
  settings,
  configured,
  onOpenSettings,
  onSaveState,
}: {
  projectId: string;
  settings: ModelSettings | null;
  configured: boolean;
  onOpenSettings: () => void;
  onSaveState: (s: 'idle' | 'saving' | 'saved' | 'failed') => void;
}) {
  const { wf, api } = useCanvasWorkflow(projectId, settings);
  const [view, setView] = useState<CanvasView>({ ...DEFAULT_CANVAS_VIEW, updatedAt: new Date().toISOString() });
  const [selectedNodeId, setSelectedNodeId] = useState<WorkflowNodeId | null>(null);
  const [libCollapsed, setLibCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [drawerExpanded, setDrawerExpanded] = useState(false);
  const canvasHandle = useRef<FlowCanvasHandle | null>(null);
  const saveTimer = useRef<number | null>(null);
  const viewLoaded = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  // 载入持久化视图（docs/12 §6：刷新恢复视口、节点位置、选中）
  useEffect(() => {
    let alive = true;
    void loadCanvasView(projectId).then((stored) => {
      if (!alive) return;
      if (stored) {
        const restored: CanvasView = {
          ...DEFAULT_CANVAS_VIEW,
          pan: stored.pan,
          zoom: stored.zoom,
          nodePositions: stored.nodePositions ?? {},
          selectedNodeId: stored.selectedNodeId ?? null,
          updatedAt: new Date().toISOString(),
        };
        viewRef.current = restored;
        setView(restored);
        setSelectedNodeId(stored.selectedNodeId ?? null);
      }
      viewLoaded.current = true;
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // 800ms 防抖自动保存视图
  const scheduleSave = useCallback(
    (next: CanvasView) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      onSaveState('saving');
      saveTimer.current = window.setTimeout(() => {
        void saveCanvasView(projectId, next).then(() => onSaveState('saved'));
      }, 800);
    },
    [onSaveState, projectId],
  );

  const patchView = useCallback(
    (patch: Partial<Pick<CanvasView, 'pan' | 'zoom' | 'nodePositions' | 'selectedNodeId'>>) => {
      // 在事件路径（非 render updater）内计算下一视图，避免渲染期触发父组件 setState
      const next: CanvasView = {
        ...viewRef.current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      viewRef.current = next;
      setView(next);
      if (Object.prototype.hasOwnProperty.call(patch, 'selectedNodeId')) {
        setSelectedNodeId((patch.selectedNodeId as WorkflowNodeId | null) ?? null);
      }
      if (viewLoaded.current) scheduleSave(next);
    },
    [scheduleSave],
  );

  const selectNode = useCallback(
    (id: WorkflowNodeId) => {
      setSelectedNodeId(id);
      setInspectorOpen(true);
      patchView({ selectedNodeId: id });
    },
    [patchView],
  );

  // 项目卡片状态计数（仅在关键状态变化时更新，失败静默，不影响使用）
  useEffect(() => {
    if (!wf) return;
    const status =
      wf.state === 'passed'
        ? ('completed' as const)
        : ['analyzing', 'generating', 'auditing', 'repairing'].includes(wf.state)
          ? ('running' as const)
          : wf.recipeConfirmed
            ? ('recipe-ready' as const)
            : ('draft' as const);
    void updateProject(projectId, {
      status,
      generatedCount: wf.attempts.filter((a) => a.image).length,
      awaitingReviewCount:
        wf.state === 'warning' || wf.state === 'needs-review' || wf.state === 'paused' ? 1 : 0,
    });
  }, [projectId, wf]);

  const nodeRunAction = useCallback(
    (id: WorkflowNodeId) => {
      selectNode(id);
      switch (id) {
        case 'referenceInput':
        case 'productInput':
          return;
        case 'recipeExtractor':
          if (!wf?.recipe) api.runAnalyze();
          return;
        case 'identityLock':
          if (wf && !wf.identityConfirmed && wf.identityFeatures.length === 0) api.runAnalyze();
          return;
        case 'sceneGenerator':
          api.runGenerate();
          return;
        case 'targetedRepair':
          api.requestRepair();
          return;
        case 'resultAuditor':
          return;
      }
    },
    [api, selectNode, wf],
  );

  const pageClass = useMemo(
    () =>
      `canvas-page ${libCollapsed ? 'lib-collapsed' : ''} ${inspectorOpen ? '' : 'inspector-collapsed'} ${drawerExpanded ? 'drawer-expanded' : ''}`,
    [libCollapsed, inspectorOpen, drawerExpanded],
  );

  return (
    <div className={pageClass} data-testid="canvas-page">
      <NodeLibrary
        collapsed={libCollapsed}
        selectedNodeId={selectedNodeId}
        onSelect={selectNode}
      />
      <div style={{ position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* 折叠节点库/检查器的细控件 + 无 Key 提示 */}
        <div className="canvas-toolbar-floating">
          <button type="button" className="icon-btn" title="放大" onClick={() => canvasHandle.current?.zoomIn()}>＋</button>
          <button type="button" className="icon-btn" title="缩小" onClick={() => canvasHandle.current?.zoomOut()}>－</button>
          <span className="zoom-indicator">{Math.round(view.zoom * 100)}%</span>
          <button type="button" className="icon-btn" title="恢复 100%" onClick={() => canvasHandle.current?.resetZoom()}>100%</button>
          <button type="button" className="icon-btn" title="适应全部节点" onClick={() => canvasHandle.current?.fitAll()}>⛶</button>
          <button
            type="button"
            className="icon-btn"
            title={libCollapsed ? '展开节点库' : '收起节点库'}
            onClick={() => setLibCollapsed((v) => !v)}
          >
            {libCollapsed ? '▸' : '▾'}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={inspectorOpen ? '收起检查器' : '展开检查器'}
            onClick={() => setInspectorOpen((v) => !v)}
          >
            {inspectorOpen ? '▸' : '◂'}
          </button>
        </div>
        {!configured && (
          <div className="canvas-nokey-banner" data-testid="canvas-nokey">
            <span>未配置模型：完整工作流可见，真实运行已禁用</span>
            <button type="button" className="btn sm primary" onClick={onOpenSettings}>配置模型</button>
          </div>
        )}
        <FlowCanvas
          wf={wf}
          view={view}
          selectedNodeId={selectedNodeId}
          onSelectNode={selectNode}
          onChange={patchView}
          onRunNode={nodeRunAction}
          handleRef={canvasHandle}
        />
      </div>
      {inspectorOpen ? (
        <InspectorPanel
          nodeId={selectedNodeId}
          wf={wf}
          configured={configured}
          api={api}
          settings={settings}
          onOpenSettings={onOpenSettings}
        />
      ) : (
        <aside className="inspector hidden" data-testid="inspector-hidden" />
      )}
      <RunDrawer
        wf={wf}
        configured={configured}
        api={api}
        onSelectNode={selectNode}
        expanded={drawerExpanded}
        onExpandedChange={setDrawerExpanded}
      />
    </div>
  );
}

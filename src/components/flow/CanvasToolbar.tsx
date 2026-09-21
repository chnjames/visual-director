import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LayoutDashboard, Map, Play, Plus, Redo2, Undo2 } from 'lucide-react';

const ZOOM_PRESETS = [50, 100, 150, 200] as const;

export function CanvasToolbar({
  canUndo,
  canRedo,
  zoom,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onFit,
  onLayout,
  miniMapOpen,
  onToggleMiniMap,
  onAddNode,
  errorCount,
  warningCount,
  issuesOpen,
  onToggleIssues,
  runDisabledReason,
  graphRunning,
  onRunWorkflow,
}: {
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomTo: (zoom: number) => void;
  onFit: () => void;
  onLayout: () => void;
  miniMapOpen: boolean;
  onToggleMiniMap: () => void;
  onAddNode: () => void;
  errorCount: number;
  warningCount: number;
  issuesOpen: boolean;
  onToggleIssues: () => void;
  runDisabledReason: string;
  graphRunning: boolean;
  onRunWorkflow: () => void;
}) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomRef = useRef<HTMLDivElement>(null);
  const percent = Math.round(zoom * 100);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (zoomOpen && zoomRef.current && !zoomRef.current.contains(target)) setZoomOpen(false);
    }
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [zoomOpen]);

  return (
    <div className="flow-dock">
      <div className="flow-toolbar" data-testid="canvas-toolbar">
        <button type="button" className="icon-btn" title="撤销 (Ctrl+Z)" aria-label="撤销" onClick={onUndo} disabled={!canUndo} data-testid="undo">
          <Undo2 size={16} />
        </button>
        <button type="button" className="icon-btn" title="重做 (Ctrl+Shift+Z)" aria-label="重做" onClick={onRedo} disabled={!canRedo} data-testid="redo">
          <Redo2 size={16} />
        </button>

        <div className="flow-split" ref={zoomRef}>
          <button
            type="button"
            className={`flow-zoom-btn ${zoomOpen ? 'is-open' : ''}`}
            title="缩放"
            aria-label="缩放菜单"
            aria-expanded={zoomOpen}
            onClick={() => setZoomOpen((open) => !open)}
            data-testid="zoom-menu-toggle"
          >
            {percent}%
            <ChevronDown size={12} />
          </button>
          {zoomOpen && (
            <div className="flow-menu flow-zoom-menu" role="menu" data-testid="zoom-menu">
              <button type="button" role="menuitem" onClick={() => { onZoomOut(); }}>
                缩小
              </button>
              <button type="button" role="menuitem" onClick={() => { onZoomIn(); }}>
                放大
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onFit();
                  setZoomOpen(false);
                }}
                data-testid="fit-all"
              >
                自适应
              </button>
              <span className="flow-menu-sep" />
              {ZOOM_PRESETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitem"
                  className={percent === value ? 'is-current' : ''}
                  onClick={() => {
                    onZoomTo(value / 100);
                    setZoomOpen(false);
                  }}
                  data-testid={`zoom-preset-${value}`}
                >
                  缩放到 {value}%
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" className="icon-btn" title="自动布局" aria-label="自动布局" onClick={onLayout} data-testid="auto-layout">
          <LayoutDashboard size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn ${miniMapOpen ? 'is-active' : ''}`}
          title="小地图"
          aria-label="小地图"
          aria-pressed={miniMapOpen}
          onClick={onToggleMiniMap}
          data-testid="toggle-minimap"
        >
          <Map size={16} />
        </button>
        <button
          type="button"
          className="flow-add-inbar"
          title="添加节点（/）"
          aria-label="添加节点"
          onClick={onAddNode}
          data-testid="open-node-library"
        >
          <Plus size={14} /> 添加节点
        </button>
      </div>

      <div className="flow-runbar">
        {(errorCount > 0 || warningCount > 0) && (
          <button
            type="button"
            className={`vbadge-btn ${errorCount > 0 ? 'is-error' : 'is-warning'}`}
            onClick={onToggleIssues}
            aria-expanded={issuesOpen}
            data-testid="toggle-validation"
          >
            {errorCount > 0 ? `${errorCount} 个错误` : `${warningCount} 条警告`}
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={!!runDisabledReason || graphRunning}
          title={runDisabledReason || '按连线运行整条工作流，结果会流转到下游节点'}
          onClick={onRunWorkflow}
          data-testid="run-workflow"
        >
          <Play size={14} /> {graphRunning ? '运行中…' : '试运行'}
        </button>
      </div>
    </div>
  );
}

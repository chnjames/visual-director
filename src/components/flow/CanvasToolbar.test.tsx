import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasToolbar } from './CanvasToolbar';

const props = {
  canUndo: false,
  canRedo: false,
  zoom: 1,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onZoomIn: vi.fn(),
  onZoomOut: vi.fn(),
  onZoomTo: vi.fn(),
  onFit: vi.fn(),
  onLayout: vi.fn(),
  miniMapOpen: false,
  onToggleMiniMap: vi.fn(),
  onAddNode: vi.fn(),
  errorCount: 0,
  warningCount: 0,
  issuesOpen: false,
  onToggleIssues: vi.fn(),
  runDisabledReason: '',
  graphRunning: false,
  onRunWorkflow: vi.fn(),
};

describe('画布底栏', () => {
  it('主栏使用撤销/重做图标，并包含缩放下拉、添加节点和试运行', () => {
    render(<CanvasToolbar {...props} />);
    expect(screen.getByTestId('undo')).toHaveAttribute('aria-label', '撤销');
    expect(screen.getByTestId('redo')).toHaveAttribute('aria-label', '重做');
    expect(screen.getByTestId('open-node-library')).toHaveTextContent('添加节点');
    expect(screen.getByTestId('run-workflow')).toHaveTextContent('试运行');
    expect(screen.queryByTestId('toggle-validation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('zoom-menu-toggle'));
    expect(screen.getByTestId('zoom-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('zoom-preset-150'));
    expect(props.onZoomTo).toHaveBeenCalledWith(1.5);
  });

  it('撤销/重做走原来的按钮逻辑；有校验错误时才显示入口', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(
      <CanvasToolbar
        {...props}
        canUndo
        canRedo
        onUndo={onUndo}
        onRedo={onRedo}
        errorCount={2}
      />,
    );
    fireEvent.click(screen.getByTestId('undo'));
    fireEvent.click(screen.getByTestId('redo'));
    expect(onUndo).toHaveBeenCalled();
    expect(onRedo).toHaveBeenCalled();
    expect(screen.getByTestId('toggle-validation')).toHaveTextContent('2 个错误');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BatchPanel } from './BatchPanel';
import { WorkflowCanvas } from './WorkflowCanvas';
import type { useBatchController } from '../../hooks/useBatchController';
import { buildReadyBatch, fakeSettings, img } from '../../batch/batchTestUtils';
import { createWorkflow } from '../../workflow/orchestrator';
import type { SingleItemWorkflow } from '../../workflow/workflowTypes';
import type { Batch } from '../../batch/batchTypes';

type Ctrl = ReturnType<typeof useBatchController>;

function stubCtrl(batch: Batch): Ctrl {
  return {
    batch,
    busy: null,
    actionError: null,
    initFromReferences: vi.fn(),
    setPurpose: vi.fn(),
    extractRecipe: vi.fn(),
    confirmRecipeGate: vi.fn(),
    addItemGroup: vi.fn(),
    removeItemGroup: vi.fn(),
    renameItemGroup: vi.fn(),
    setItemImages: vi.fn(),
    setItemIdentityMode: vi.fn(),
    confirmGroupingGate: vi.fn(),
    confirmBudgetGate: vi.fn(),
    toggleNode: vi.fn(),
    start: vi.fn(),
    pauseAll: vi.fn(),
    resumeAll: vi.fn(),
    pauseItem: vi.fn(),
    resumeItem: vi.fn(),
    retryItem: vi.fn(),
    skipItem: vi.fn(),
    setFeature: vi.fn(),
    confirmIdentity: vi.fn(),
    skipIdentity: vi.fn(),
    applyRepair: vi.fn(),
    acceptItem: vi.fn(),
    reset: vi.fn(),
  } as unknown as Ctrl;
}

describe('BatchPanel 未配置态', () => {
  it('无 Key 且无批次：只读等待，不崩溃、不伪造结果', () => {
    const ctrl = stubCtrl(null as unknown as Batch);
    render(
      <BatchPanel ctrl={ctrl} settings={null} configured={false} onOpenSettings={() => {}} />,
    );
    expect(screen.getByTestId('batch-readonly-note')).toBeTruthy();
    expect(screen.queryByTestId('start-batch')).toBeNull();
  });
});

describe('BatchPanel 准备/预算', () => {
  it('分组确认后展示预计/最坏调用数（开始前明示预算）', () => {
    const ready = buildReadyBatch(2, { identityMode: 'lock' });
    // 回到“已确认分组、未确认预算”的 setup 步骤以展示预算面板
    const batch: Batch = { ...ready, status: 'setup', budgetConfirmed: false };
    const ctrl = stubCtrl(batch);
    render(
      <BatchPanel ctrl={ctrl} settings={fakeSettings()} configured onOpenSettings={() => {}} />,
    );
    expect(screen.getByTestId('budget-expected').textContent).toContain('6');
    expect(screen.getByTestId('budget-worst').textContent).toContain('12');
    fireEvent.click(screen.getByTestId('confirm-budget'));
    expect(ctrl.confirmBudgetGate).toHaveBeenCalled();
  });

  it('ready 批次可开始', () => {
    const batch = buildReadyBatch(2, { identityMode: 'lock' });
    const ctrl = stubCtrl(batch);
    render(
      <BatchPanel ctrl={ctrl} settings={fakeSettings()} configured onOpenSettings={() => {}} />,
    );
    const start = screen.getByTestId('start-batch') as HTMLButtonElement;
    fireEvent.click(start);
    expect(ctrl.start).toHaveBeenCalled();
  });
});

describe('BatchPanel 运行态', () => {
  function runningBatch(status: Batch['status'] = 'running'): Batch {
    const b = buildReadyBatch(3, { identityMode: 'skip' });
    const wf = (state: SingleItemWorkflow['state']): SingleItemWorkflow => {
      const w = createWorkflow({
        referenceImages: [img('r')],
        productImages: [img('a'), img('b')],
        taskPurpose: '用途',
      });
      return { ...w, state, identityConfirmed: true };
    };
    const items = b.items.map((it, i) => ({
      ...it,
      wf: [wf('passed'), wf('generating'), wf('failed')][i],
      startedAt: new Date().toISOString(),
    }));
    return { ...b, status, items };
  }

  it('运行中：展示进度与逐行状态，提供暂停操作', () => {
    const ctrl = stubCtrl(runningBatch('running'));
    render(
      <BatchPanel ctrl={ctrl} settings={fakeSettings()} configured onOpenSettings={() => {}} />,
    );
    expect(screen.getByTestId('batch-running')).toBeTruthy();
    expect(screen.getByTestId('pause-all')).toBeTruthy();
    expect(screen.queryByTestId('resume-all')).toBeNull();
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(3);
    expect(screen.getAllByTestId(/^state-/).map((e) => e.textContent)).toEqual(
      expect.arrayContaining(['通过', '生成中', '失败']),
    );
  });

  it('暂停后提供继续；系统级暂停显示横幅', () => {
    const ctrl = stubCtrl(runningBatch('paused'));
    const { unmount } = render(
      <BatchPanel ctrl={ctrl} settings={fakeSettings()} configured onOpenSettings={() => {}} />,
    );
    expect(screen.getByTestId('resume-all')).toBeTruthy();
    unmount();

    const sys: Batch = {
      ...runningBatch('system-paused'),
      systemError: {
        ok: false as const,
        errorClass: 'invalid-key' as const,
        message: 'Key 无效',
        diagnostics: { endpointMasked: '', model: '' },
      },
    };
    render(
      <BatchPanel ctrl={stubCtrl(sys)} settings={fakeSettings()} configured onOpenSettings={() => {}} />,
    );
    expect(screen.getByTestId('system-paused-banner')).toBeTruthy();
  });
});

describe('WorkflowCanvas', () => {
  it('无批次显示空态', () => {
    render(<WorkflowCanvas batch={null} onToggleNode={() => {}} />);
    expect(screen.getByTestId('canvas-empty')).toBeTruthy();
  });

  it('渲染固定 7 节点与边，仅 2 个节点可跳过', () => {
    const batch = buildReadyBatch(1);
    render(<WorkflowCanvas batch={batch} onToggleNode={() => {}} />);
    expect(screen.getByTestId('workflow-canvas')).toBeTruthy();
    const nodeIds = ['referenceInput', 'productInput', 'recipeExtractor', 'identityLock', 'sceneGenerator', 'resultAuditor', 'targetedRepair'];
    for (const id of nodeIds) expect(screen.getByTestId(`canvas-node-${id}`)).toBeTruthy();
    expect(screen.getByTestId('canvas-skip-identityLock')).toBeTruthy();
    expect(screen.getByTestId('canvas-skip-resultAuditor')).toBeTruthy();
    expect(screen.queryByTestId('canvas-skip-sceneGenerator')).toBeNull();
  });

  it('切换可跳过节点触发回调', () => {
    const onToggle = vi.fn();
    const batch = buildReadyBatch(1);
    render(<WorkflowCanvas batch={batch} onToggleNode={onToggle} />);
    fireEvent.click(screen.getByTestId('canvas-skip-resultAuditor'));
    expect(onToggle).toHaveBeenCalledWith('resultAuditor');
  });
});

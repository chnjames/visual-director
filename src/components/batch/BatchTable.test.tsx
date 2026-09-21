import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BatchTable } from './BatchTable';

const start = vi.fn();
const selectVersion = vi.fn();
const addRow = vi.fn();
const patchShared = vi.fn();
const setSharedReferenceImages = vi.fn();

vi.mock('../../hooks/useBatchJob', () => ({
  useBatchJob: () => ({
    loaded: true,
    actionError: null,
    versions: [
      {
        id: 'ver-1',
        versionNo: 1,
        name: '参考图辅助',
        graph: { nodes: [], edges: [] },
        plan: null,
      },
    ],
    job: {
      schemaVersion: 3,
      id: 'batch-1',
      projectId: 'p1',
      workflowVersionId: 'ver-1',
      workflowVersionNo: 1,
      status: 'draft',
      shared: {
        referenceImages: [],
        purpose: 'main-scene',
        positivePrompt: '',
      },
      rows: [],
      createdAt: '',
      updatedAt: '',
    },
    contract: {
      runnable: true,
      summary: '共享参考图 + 用途 + 共享提示词 + 每行商品图',
      shared: {
        referenceImages: true,
        purpose: true,
        positivePrompt: true,
      },
      perRow: {
        productImages: true,
        promptOverride: false,
        generationOverrides: true,
      },
      defaultPositivePrompt: '',
      defaultPurpose: 'main-scene',
      estimatedModelCallsPerRow: 2,
    },
    budget: null,
    selectVersion,
    patchShared,
    setSharedReferenceImages,
    addRow,
    removeRow: vi.fn(),
    patchRow: vi.fn(),
    setRowImages: vi.fn(),
    start,
    pause: vi.fn(),
    retry: vi.fn(),
    reset: vi.fn(),
  }),
}));

describe('BatchTable 动态输入', () => {
  it('按合同展示共享参考图与提示词，并显示版本输入摘要', () => {
    render(
      <BatchTable
        projectId="p1"
        settings={null}
        configured={false}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByTestId('batch-contract-summary').textContent).toContain('共享参考图');
    expect(screen.getByTestId('batch-shared-inputs')).toBeInTheDocument();
    expect(screen.getByText(/上传参考图/)).toBeInTheDocument();
    expect(screen.getByTestId('batch-shared-prompt')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('batch-shared-prompt'), {
      target: { value: '浅色台面' },
    });
    expect(patchShared).toHaveBeenCalledWith({ positivePrompt: '浅色台面' });
    fireEvent.click(screen.getByTestId('batch-add-row'));
    expect(addRow).toHaveBeenCalled();
  });
});

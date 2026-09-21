import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelSettings } from '../../shared/types';
import type { NodeInstance, WorkflowGraph } from '../../workflow/graph/types';
import { NodeCard } from './NodeCard';
import { NodeInspector } from './NodeInspector';

vi.mock('../../model/images', () => ({
  readImageFile: vi.fn(async (file: File) => ({
    id: 'uploaded-1',
    name: file.name,
    mediaType: file.type,
    dataUri: 'data:image/png;base64,QUJD',
    bytes: file.size,
  })),
}));

const node: NodeInstance = {
  id: 'generate-1',
  type: 'sceneGenerate',
  position: { x: 0, y: 0 },
  config: {
    productImages: [],
    positivePrompt: '',
    negativePrompt: '',
    targetUse: 'main-scene',
    aspectRatio: '1:1',
    resolution: '2K',
    count: 1,
  },
};

const graph: WorkflowGraph = { nodes: [node], edges: [] };
const settings: ModelSettings = {
  apiKey: 'secret',
  seedEndpoint: 'ep-text',
  imageEndpoint: 'ep-seedream-5',
  protocol: 'openai',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
};

describe('商品场景生成配置', () => {
  it('节点卡片只显示摘要，不再承载缩放画布内表单', () => {
    render(
      <NodeCard
        node={node}
        graph={graph}
        selected={false}
        dimmed={false}
        invalid={false}
        warning={false}
        hoverPort={null}
        connectError={null}
        onNodeMouseDown={() => {}}
        onSelect={() => {}}
        onPortMouseDown={() => {}}
        onPortEnter={() => {}}
        onPortLeave={() => {}}
        onPortUp={() => {}}
        onConfigChange={() => {}}
        mode="flow"
      />,
    );
    expect(screen.getByText('尚未上传商品图')).toBeInTheDocument();
    expect(screen.getByText('主图 · 场景展示')).toBeInTheDocument();
    expect(screen.queryByTestId('inline-targetUse')).not.toBeInTheDocument();
    expect(screen.queryByTestId('node-image-upload')).not.toBeInTheDocument();
  });

  it('参考图分析卡片用途显示中文，排除主体整句横排', () => {
    const analyze: NodeInstance = {
      id: 'analyze-card',
      type: 'referenceAnalyze',
      position: { x: 0, y: 0 },
      config: { images: [], purpose: 'detail-closeup', excludeSubject: true },
    };
    render(
      <NodeCard
        node={analyze}
        graph={{ nodes: [analyze], edges: [] }}
        selected={false}
        dimmed={false}
        invalid={false}
        warning={false}
        hoverPort={null}
        connectError={null}
        onNodeMouseDown={() => {}}
        onSelect={() => {}}
        onPortMouseDown={() => {}}
        onPortEnter={() => {}}
        onPortLeave={() => {}}
        onPortUp={() => {}}
        onConfigChange={() => {}}
        mode="flow"
      />,
    );
    expect(screen.getByTestId('inline-purpose')).toHaveDisplayValue('详情 · 细节规格');
    expect(screen.getByText('排除参考图中的商品主体')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('detail-closeup')).not.toBeInTheDocument();
  });

  it('绑定失败留下的占位正文在提示词卡片上显示为空', () => {
    const editor: NodeInstance = {
      id: 'editor-empty',
      type: 'promptEditor',
      position: { x: 0, y: 0 },
      config: {
        positivePrompt: '（无分析结果）\ndetail-closeup',
        appliedFromAnalysisAt: '2026-09-21T00:00:00.000Z',
      },
    };
    render(
      <NodeCard
        node={editor}
        graph={{ nodes: [editor], edges: [] }}
        selected={false}
        dimmed={false}
        invalid={false}
        warning={false}
        hoverPort={null}
        connectError={null}
        onNodeMouseDown={() => {}}
        onSelect={() => {}}
        onPortMouseDown={() => {}}
        onPortEnter={() => {}}
        onPortLeave={() => {}}
        onPortUp={() => {}}
        onConfigChange={() => {}}
        mode="flow"
      />,
    );
    expect(screen.getByTestId('prompt-editor-status')).toHaveTextContent('尚未填写提示词');
    expect(screen.queryByText(/detail-closeup/)).not.toBeInTheDocument();
  });

  it('结果展示节点未运行时显示占位', () => {
    const gallery: NodeInstance = {
      id: 'gallery-empty',
      type: 'resultGallery',
      position: { x: 280, y: 0 },
      config: {},
    };
    render(
      <NodeCard
        node={gallery}
        graph={{ nodes: [gallery], edges: [] }}
        selected={false}
        dimmed={false}
        invalid={false}
        warning={false}
        hoverPort={null}
        connectError={null}
        onNodeMouseDown={() => {}}
        onSelect={() => {}}
        onPortMouseDown={() => {}}
        onPortEnter={() => {}}
        onPortLeave={() => {}}
        onPortUp={() => {}}
        onConfigChange={() => {}}
        mode="flow"
      />,
    );
    expect(screen.getByText('整图运行后，生成图会显示在这里')).toBeInTheDocument();
  });

  it('结果展示节点显示生成图，点击可放大查看', () => {
    const gallery: NodeInstance = {
      id: 'gallery-1',
      type: 'resultGallery',
      position: { x: 280, y: 0 },
      config: {
        lastOutputImages: [{ dataUri: 'data:image/png;base64,QUJD', mediaType: 'image/png' }],
      },
    };
    render(
      <NodeCard
        node={gallery}
        graph={{ nodes: [gallery], edges: [] }}
        selected={false}
        dimmed={false}
        invalid={false}
        warning={false}
        hoverPort={null}
        connectError={null}
        onNodeMouseDown={() => {}}
        onSelect={() => {}}
        onPortMouseDown={() => {}}
        onPortEnter={() => {}}
        onPortLeave={() => {}}
        onPortUp={() => {}}
        onConfigChange={() => {}}
        mode="flow"
      />,
    );
    fireEvent.click(screen.getByLabelText('放大查看结果 1'));
    expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
  });

  it('点击节点摘要会打开检查器，且不会把点击交给画布空白处', () => {
    const onSelect = vi.fn();
    const onPaneClick = vi.fn();
    render(
      <div onClick={onPaneClick}>
        <NodeCard
          node={node}
          graph={graph}
          selected={false}
          dimmed={false}
          invalid={false}
          warning={false}
          hoverPort={null}
          connectError={null}
          onNodeMouseDown={() => {}}
          onSelect={onSelect}
          onPortMouseDown={() => {}}
          onPortEnter={() => {}}
          onPortLeave={() => {}}
          onPortUp={() => {}}
          onConfigChange={() => {}}
          mode="flow"
        />
      </div>,
    );

    fireEvent.click(screen.getByText('尚未上传商品图'));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: 'generate-1' });
    expect(onPaneClick).not.toHaveBeenCalled();

    onSelect.mockClear();
    onPaneClick.mockClear();
    fireEvent.click(screen.getByText('商品场景生成'));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: 'generate-1' });
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it('专用面板可上传、编辑提示词并修改全部核心规格', async () => {
    const onConfigChange = vi.fn();
    const onRunNode = vi.fn();
    const { container } = render(
      <NodeInspector
        node={node}
        graph={graph}
        issues={[]}
        onClose={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
        onConfigChange={onConfigChange}
        configured
        settings={settings}
        onOpenSettings={() => {}}
        onRunNode={onRunNode}
      />,
    );

    expect(screen.getByTestId('inspector-run-node')).toHaveTextContent('试运行');
    fireEvent.click(screen.getByTestId('inspector-run-node'));
    expect(onRunNode).toHaveBeenCalledTimes(1);

    expect(screen.getByText('ep-seedream-5')).toBeInTheDocument();
    expect(screen.queryByText('{{productImages}}')).not.toBeInTheDocument();
    expect(screen.getByTestId('cfg-targetUse')).toHaveDisplayValue('主图 · 场景展示');
    const uploadTrigger = screen.getByTestId('node-image-upload');
    expect(uploadTrigger.tagName).toBe('LABEL');

    fireEvent.change(screen.getByTestId('cfg-generation-prompt'), {
      target: { value: '浅色石材台面的护肤品场景图' },
    });
    fireEvent.change(screen.getByTestId('cfg-targetUse'), {
      target: { value: 'detail-scene' },
    });
    fireEvent.click(screen.getByRole('button', { name: '3:4 · 竖版' }));
    fireEvent.click(screen.getByRole('button', { name: '3K · 高清输出' }));
    fireEvent.click(screen.getByRole('button', { name: '增加生成数量' }));

    expect(onConfigChange).toHaveBeenCalledWith(
      'generate-1',
      'positivePrompt',
      '浅色石材台面的护肤品场景图',
    );
    expect(onConfigChange).toHaveBeenCalledWith('generate-1', 'targetUse', 'detail-scene');
    expect(onConfigChange).toHaveBeenCalledWith('generate-1', 'aspectRatio', '3:4');
    expect(onConfigChange).toHaveBeenCalledWith('generate-1', 'resolution', '3K');
    expect(onConfigChange).toHaveBeenCalledWith('generate-1', 'count', 2);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(uploadTrigger).toHaveAttribute('for', fileInput.id);
    expect(fileInput).not.toBeDisabled();
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['image'], 'product.png', { type: 'image/png' })],
      },
    });
    await waitFor(() =>
      expect(onConfigChange).toHaveBeenCalledWith(
        'generate-1',
        'productImages',
        [expect.objectContaining({ name: 'product.png' })],
      ),
    );
  });

  it('检查器运行失败只显示一次，并可去更换 Key', () => {
    const onOpenSettings = vi.fn();
    render(
      <NodeInspector
        node={node}
        graph={graph}
        issues={[]}
        onClose={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
        onConfigChange={() => {}}
        configured
        settings={settings}
        onOpenSettings={onOpenSettings}
        onRunNode={() => {}}
        runPreview={{
          status: 'error',
          errorClass: 'invalid-key',
          message: '当前 API Key 未被图片接口接受。请使用火山方舟控制台「API Key 管理」创建的 Key，不要使用 Agent Plan / Coding Plan 的 Key。',
        }}
      />,
    );
    expect(screen.getAllByText(/未被图片接口接受/).length).toBe(1);
    expect(screen.queryByText(/Request id/)).toBeNull();
    fireEvent.click(screen.getByTestId('inspector-run-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('连了提示词节点时，生成检查器提示词只读且不出现优化', () => {
    const editor: NodeInstance = {
      id: 'editor-1',
      type: 'promptEditor',
      position: { x: 0, y: 0 },
      config: { positivePrompt: '浅色石材台面' },
    };
    const generate: NodeInstance = { ...node, id: 'generate-2' };
    render(
      <NodeInspector
        node={generate}
        graph={{
          nodes: [editor, generate],
          edges: [{ id: 'e1', from: { node: 'editor-1', port: 'prompt' }, to: { node: 'generate-2', port: 'prompt' } }],
        }}
        issues={[]}
        onClose={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
        onConfigChange={() => {}}
        configured
        settings={settings}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByTestId('generation-prompt-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('cfg-generation-prompt')).not.toBeInTheDocument();
    expect(screen.queryByTestId('optimize-block')).not.toBeInTheDocument();
    expect(screen.getByText('浅色石材台面')).toBeInTheDocument();
  });

  it('连了商品图节点时，生成检查器不再上传商品图', () => {
    const products: NodeInstance = {
      id: 'products-1',
      type: 'productImages',
      position: { x: 0, y: 0 },
      config: {
        images: [{ dataUri: 'data:image/png;base64,QUJD', mediaType: 'image/png', name: 'sku.png' }],
      },
    };
    const generate: NodeInstance = { ...node, id: 'generate-3' };
    render(
      <NodeInspector
        node={generate}
        graph={{
          nodes: [products, generate],
          edges: [{ id: 'e-products', from: { node: 'products-1', port: 'images' }, to: { node: 'generate-3', port: 'products' } }],
        }}
        issues={[]}
        onClose={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
        onConfigChange={() => {}}
        onSelectNode={() => {}}
        configured
        settings={settings}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByTestId('generation-products-readonly')).toBeInTheDocument();
    expect(screen.getByText('来自：商品图')).toBeInTheDocument();
    expect(screen.queryByText('上传商品图')).not.toBeInTheDocument();
    expect(screen.getByTestId('jump-to-product-source')).toBeInTheDocument();
  });

  it('参考图分析检查器展示建议提示词和采用，不出现确认配方', () => {
    const analyze: NodeInstance = {
      id: 'analyze-1',
      type: 'referenceAnalyze',
      position: { x: 0, y: 0 },
      config: {
        images: [],
        purpose: 'main-scene',
        excludeSubject: true,
        suggestedPrompt: '浅色石材台面，柔和侧光',
      },
    };
    const editor: NodeInstance = {
      id: 'editor-1',
      type: 'promptEditor',
      position: { x: 280, y: 0 },
      config: { positivePrompt: '' },
    };
    const onConfigsChange = vi.fn();
    render(
      <NodeInspector
        node={analyze}
        graph={{
          nodes: [analyze, editor],
          edges: [{ id: 'e1', from: { node: 'analyze-1', port: 'recipe' }, to: { node: 'editor-1', port: 'recipe' } }],
        }}
        issues={[]}
        onClose={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
        onConfigChange={() => {}}
        onConfigsChange={onConfigsChange}
        configured
        settings={settings}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByTestId('analysis-config')).toBeInTheDocument();
    expect(screen.getByTestId('suggested-prompt')).toHaveTextContent('浅色石材台面，柔和侧光');
    expect(screen.queryByTestId('confirm-recipe')).not.toBeInTheDocument();
    expect(screen.getByText(/不会作为生成参考图发送/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('apply-suggested-prompt'));
    expect(onConfigsChange).toHaveBeenCalledWith(
      'editor-1',
      expect.objectContaining({ positivePrompt: '浅色石材台面，柔和侧光', promptEditedByUser: false }),
    );
  });

  it('提示词节点默认空，可从分析采用并带优化', () => {
    const analyze: NodeInstance = {
      id: 'analyze-1',
      type: 'referenceAnalyze',
      position: { x: 0, y: 0 },
      config: { suggestedPrompt: '侧光台面' },
    };
    const editor: NodeInstance = {
      id: 'editor-1',
      type: 'promptEditor',
      position: { x: 280, y: 0 },
      config: { positivePrompt: '' },
    };
    const onConfigsChange = vi.fn();
    render(
      <NodeInspector
        node={editor}
        graph={{
          nodes: [analyze, editor],
          edges: [{ id: 'e1', from: { node: 'analyze-1', port: 'recipe' }, to: { node: 'editor-1', port: 'recipe' } }],
        }}
        issues={[]}
        onClose={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
        onConfigChange={() => {}}
        onConfigsChange={onConfigsChange}
        configured
        settings={settings}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByTestId('prompt-editor-panel')).toBeInTheDocument();
    expect(screen.getByTestId('cfg-prompt-editor')).toHaveValue('');
    expect(screen.getByTestId('optimize-prompt')).toHaveTextContent('优化');
    fireEvent.click(screen.getByRole('button', { name: '填入分析建议' }));
    expect(onConfigsChange).toHaveBeenCalledWith(
      'editor-1',
      expect.objectContaining({ positivePrompt: '侧光台面', promptEditedByUser: false }),
    );
  });

  it('旧的空提示词预览日志不再显示英文占位', () => {
    const editor: NodeInstance = {
      id: 'editor-log',
      type: 'promptEditor',
      position: { x: 0, y: 0 },
      config: {
        positivePrompt: '浅色石材台面，柔和侧光',
        lastRunIo: {
          scope: 'node',
          ok: true,
          message: '已预览',
          finishedAt: '2026-09-21T00:00:00.000Z',
          durationMs: 12,
          inputs: [{ key: 'positivePrompt', label: '当前提示词', kind: 'text', text: '（无分析结果）\ndetail-closeup' }],
          outputs: [{ key: 'preview', label: '将送给生成节点', kind: 'text', text: '（无分析结果）\ndetail-closeup' }],
        },
      },
    };
    render(
      <NodeInspector
        node={editor}
        graph={{ nodes: [editor], edges: [] }}
        issues={[]}
        onClose={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
        onConfigChange={() => {}}
        configured
        settings={settings}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByTestId('stale-prompt-log')).toHaveTextContent('以上方输入框为准');
    expect(screen.queryByText(/detail-closeup/)).not.toBeInTheDocument();
  });
});

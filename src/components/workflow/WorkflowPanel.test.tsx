import type { ReactElement } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { WorkflowPanel } from './WorkflowPanel';
import type { ModelSettings } from '../../shared/types';

beforeEach(() => {
  sessionStorage.clear();
});

const SETTINGS: ModelSettings = {
  apiKey: 'sk-x',
  seedEndpoint: 'ep-seed',
  imageEndpoint: '',
  protocol: 'openai',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
};

async function renderNode(node: ReactElement) {
  await act(async () => {
    render(node);
  });
}

describe('WorkflowPanel', () => {
  it('未配置 Key 时显示等待闸门，不崩溃', async () => {
    await renderNode(<WorkflowPanel settings={null} onOpenSettings={() => {}} />);
    expect(screen.getByTestId('not-configured-gate')).toBeInTheDocument();
  });

  it('初始展示固定主干说明、素材输入与调用预算 4/7', async () => {
    await renderNode(<WorkflowPanel settings={SETTINGS} onOpenSettings={() => {}} />);
    expect(screen.getByTestId('wf-setup')).toBeInTheDocument();
    expect(screen.getByTestId('call-budget').textContent).toContain('4');
    expect(screen.getByTestId('call-budget').textContent).toContain('7');
    expect(screen.getByText(/参考图（决定视觉风格/)).toBeInTheDocument();
    expect(screen.getByText(/商品多角度图/)).toBeInTheDocument();
    expect(screen.getByTestId('wf-create') as HTMLButtonElement).toBeDisabled();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SEEDREAM_5_MODEL_ID } from '../shared/constants';
import { ModelSettingsModal } from './ModelSettingsModal';

describe('模型设置', () => {
  it('只填图片通道的 Key 和推荐模型即可保存', () => {
    const onSave = vi.fn();
    render(
      <ModelSettingsModal
        open
        initial={null}
        onSave={onSave}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('image-apikey-input'), { target: { value: 'sk-image' } });
    fireEvent.click(screen.getByTestId('use-seedream-5'));
    expect(screen.getByTestId('imageendpoint-input')).toHaveValue(SEEDREAM_5_MODEL_ID);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-image',
        imageApiKey: 'sk-image',
        textApiKey: '',
        seedEndpoint: '',
        imageEndpoint: SEEDREAM_5_MODEL_ID,
        imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
    );
  });

  it('图片和文本可以保存不同的 Key / 模型 / Base URL', () => {
    const onSave = vi.fn();
    render(
      <ModelSettingsModal
        open
        initial={null}
        onSave={onSave}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('image-apikey-input'), { target: { value: 'sk-image' } });
    fireEvent.click(screen.getByTestId('use-seedream-5'));
    fireEvent.change(screen.getByTestId('text-apikey-input'), { target: { value: 'sk-text' } });
    fireEvent.change(screen.getByTestId('endpoint-input'), { target: { value: 'ep-seed-001' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-image',
        imageApiKey: 'sk-image',
        textApiKey: 'sk-text',
        seedEndpoint: 'ep-seed-001',
        imageEndpoint: SEEDREAM_5_MODEL_ID,
        imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      }),
    );
  });

  it('未填图片模型时，实测按钮提示缺失项且不发请求', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <ModelSettingsModal
        open
        initial={null}
        onSave={() => {}}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('image-apikey-input'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByTestId('image-test-btn'));

    expect(screen.getByTestId('image-test-result')).toHaveTextContent('请先填写图片通道的 API Key 和模型 ID');
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('底部只保留断开/取消/保存，测试入口在通道标题栏', () => {
    render(
      <ModelSettingsModal
        open
        initial={{
          apiKey: 'sk-saved',
          imageApiKey: 'sk-saved',
          textApiKey: '',
          seedEndpoint: '',
          imageEndpoint: 'doubao-seedream-5-0-250928',
          imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          protocol: 'openai',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        }}
        onSave={() => {}}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '断开并清除 Key' })).toHaveClass('danger');
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /实测图片模型/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('image-test-btn')).toHaveTextContent('测试');
    expect(screen.getByTestId('text-test-btn')).toHaveTextContent('测试');
  });
});

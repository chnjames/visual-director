import { imageApiKeyOf, textApiKeyOf, maskEndpoint } from '../../shared/security';
import type { ModelSettings } from '../../shared/types';

function statusCopy(settings: ModelSettings | null): { text: string; title: string } {
  if (!settings) {
    return { text: '未连接', title: '尚未配置模型，点击打开模型连接' };
  }
  const imageOn = imageApiKeyOf(settings).length > 0 && settings.imageEndpoint.trim().length > 0;
  const textOn = textApiKeyOf(settings).length > 0 && settings.seedEndpoint.trim().length > 0;
  const detail = [
    imageOn ? `图片 ${maskEndpoint(settings.imageEndpoint)}` : '',
    textOn ? `文本 ${maskEndpoint(settings.seedEndpoint)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (imageOn && textOn) return { text: '已连接', title: `${detail} · 打开模型连接` };
  if (imageOn) return { text: '图片已连接', title: `${detail} · 打开模型连接` };
  if (textOn) return { text: '文本已连接', title: `${detail} · 打开模型连接` };
  return { text: '未连接', title: '尚未配置模型，点击打开模型连接' };
}

/**
 * 顶栏连接状态：只回答能不能跑。详情放 title，点击进模型连接。
 * 设置入口仍在「更多」和侧栏，这里不重复展开 Endpoint。
 */
export function ModelStatusPill({
  settings,
  configured,
  onClick,
}: {
  settings: ModelSettings | null;
  configured: boolean;
  onClick: () => void;
}) {
  const copy = statusCopy(configured ? settings : null);
  return (
    <button
      type="button"
      className={`status-pill ${configured ? 'ready' : ''}`}
      data-testid="model-status"
      title={copy.title}
      onClick={onClick}
    >
      <span className="dot" />
      {copy.text}
    </button>
  );
}

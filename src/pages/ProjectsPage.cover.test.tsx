import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import App from '../App';
import { createProject, updateProject } from '../data/projectStore';
import { upsertAsset } from '../data/assetStore';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = '';
});

async function settle(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

describe('项目首页封面', () => {
  it('有生成图显示封面、无图显示占位；悬空 coverAssetId 回退最新生成图；任何卡片都不出现空 src 裂图', async () => {
    // 1) 无封面项目
    const empty = await createProject('封面测试-无图');

    // 2) 正常封面项目：coverAssetId 指向生成图
    const covered = await createProject('封面测试-有图');
    const gen = await upsertAsset({
      projectId: covered.id,
      kind: 'generated',
      name: 'g.png',
      dataUri: 'data:image/png;base64,COVER1',
      mediaType: 'image/png',
      source: 'canvas-run',
    });
    await updateProject(covered.id, { status: 'completed', generatedCount: 1, coverAssetId: gen.id });

    // 3) 悬空封面项目：coverAssetId 指向已不存在的素材，但项目里有生成图 → 回退显示
    const dangling = await createProject('封面测试-悬空');
    const fallback = await upsertAsset({
      projectId: dangling.id,
      kind: 'generated',
      name: 'g2.png',
      dataUri: 'data:image/png;base64,FALLBACK1',
      mediaType: 'image/png',
      source: 'canvas-run',
    });
    await updateProject(dangling.id, {
      status: 'completed',
      generatedCount: 1,
      coverAssetId: 'ast_dead_asset',
    });

    render(<App />);
    await settle();

    // 三张卡片都在
    expect(screen.getByTestId(`project-card-${empty.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`project-card-${covered.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`project-card-${dangling.id}`)).toBeInTheDocument();

    // 两张封面图：正常封面 + 悬空回退封面
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.project-cover img'));
    expect(imgs).toHaveLength(2);
    const srcs = imgs.map((i) => i.getAttribute('src') ?? '');
    expect(srcs.some((s) => s.includes('COVER1'))).toBe(true);
    expect(srcs.some((s) => s.includes('FALLBACK1'))).toBe(true);
    // 旧 BUG 的空 src 绝不允许出现
    expect(document.querySelector('.project-cover img[src=""]')).toBeNull();
    // 无图项目显示占位
    expect(document.querySelectorAll('.project-cover-placeholder')).toHaveLength(1);
    expect(fallback.id).toBeTruthy();

    // dataUri 加载失败时回退占位，不显示裂图
    fireEvent.error(imgs[0]);
    await settle(1);
    expect(document.querySelectorAll('.project-cover img')).toHaveLength(1);
    expect(document.querySelectorAll('.project-cover-placeholder')).toHaveLength(2);
  });
});

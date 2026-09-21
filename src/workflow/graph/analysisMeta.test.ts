import { describe, expect, it } from 'vitest';
import {
  heuristicAnalysisMeta,
  mergeAnalysisMeta,
  parseAnalysisMeta,
  purposeBucketOf,
} from './analysisMeta';
import type { UploadedImage } from '../../shared/types';

const imgs = (n: number): UploadedImage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `ref${i + 1}`,
    dataUri: `data:image/png;base64,${i}`,
    mediaType: 'image/png',
    name: `a${i}.png`,
  }));

describe('analysisMeta', () => {
  it('用途桶识别主图/详情', () => {
    expect(purposeBucketOf('主图 · 场景展示')).toBe('hero');
    expect(purposeBucketOf('详情 · 首屏主视觉')).toBe('detail');
    expect(purposeBucketOf('')).toBe('unknown');
  });

  it('多图且用途不明时给出冲突提示', () => {
    const meta = heuristicAnalysisMeta('', imgs(2));
    expect(meta.conflictHint).toMatch(/主图与详情/);
  });

  it('解析模型 meta 并与启发式合并', () => {
    const images = imgs(2);
    const fromModel = parseAnalysisMeta(
      {
        meta: {
          imageRoles: [
            { sourceId: 'ref1', role: 'hero' },
            { sourceId: 'ref2', role: 'detail' },
          ],
          conflictHint: '',
        },
      },
      images,
    );
    const merged = mergeAnalysisMeta(heuristicAnalysisMeta('主图 · 白底产品', images), fromModel);
    expect(merged.imageRoles).toHaveLength(2);
    expect(merged.conflictHint).toMatch(/主图与详情/);
  });
});

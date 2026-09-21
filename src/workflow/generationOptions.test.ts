import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_DEFAULTS,
  generationDefaultsToConfig,
  normalizeGenerationDefaults,
  purposeLabel,
} from './generationOptions';

describe('生成默认值', () => {
  it('缺省与非法值回落到出厂默认', () => {
    expect(normalizeGenerationDefaults(undefined)).toEqual(DEFAULT_GENERATION_DEFAULTS);
    expect(normalizeGenerationDefaults({ aspectRatio: '7:3', count: 0, targetUse: '' })).toEqual({
      ...DEFAULT_GENERATION_DEFAULTS,
      count: 1,
    });
  });

  it('写出的配置只含四个生成字段', () => {
    expect(generationDefaultsToConfig(DEFAULT_GENERATION_DEFAULTS)).toEqual({
      aspectRatio: '1:1',
      resolution: '2K',
      count: 1,
      targetUse: 'main-scene',
    });
  });

  it('用途 key 展示为中文，自定义文案原样保留', () => {
    expect(purposeLabel('detail-closeup')).toBe('详情 · 细节规格');
    expect(purposeLabel('main-scene')).toBe('主图 · 场景展示');
    expect(purposeLabel('详情页首屏')).toBe('详情页首屏');
    expect(purposeLabel('')).toBe('');
  });
});

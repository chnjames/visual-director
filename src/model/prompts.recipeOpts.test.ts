import { describe, expect, it } from 'vitest';
import { buildRecipeMessages } from './prompts';
import type { UploadedImage } from '../shared/types';

const img: UploadedImage = {
  id: 'ref1',
  dataUri: 'data:image/png;base64,aGk=',
  mediaType: 'image/png',
  name: 'a.png',
};

describe('buildRecipeMessages', () => {
  it('注入用途与排除主体约束', () => {
    const msgs = buildRecipeMessages([img], {
      purpose: '主图 · 场景展示',
      excludeSubject: true,
    });
    const system = String(msgs[0].content);
    const user = msgs[1].content;
    const userText = Array.isArray(user) ? user.find((p) => p.type === 'text')?.text ?? '' : String(user);
    expect(system).toMatch(/忽略参考图中的商品主体/);
    expect(userText).toMatch(/主图 · 场景展示/);
  });

  it('未排除主体时不写特别约束', () => {
    const msgs = buildRecipeMessages([img], { excludeSubject: false });
    expect(String(msgs[0].content)).not.toMatch(/忽略参考图中的商品主体/);
  });
});

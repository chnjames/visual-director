import { describe, it, expect } from 'vitest';
import { extractJson } from './parseJson';

describe('extractJson 健壮解析', () => {
  it('解析纯 JSON', () => {
    const r = extractJson('{"a":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as any).a).toBe(1);
  });

  it('去除 ```json 代码围栏', () => {
    const r = extractJson('```json\n{"a":2}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as any).a).toBe(2);
  });

  it('从前后噪声中截取平衡对象（字符串内含括号不被误截断）', () => {
    const text = '好的，结果如下：{"a":"}","b":{"c":3}} 以上。';
    const r = extractJson(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as any).a).toBe('}');
      expect((r.value as any).b.c).toBe(3);
    }
  });

  it('空输出与无 JSON 均失败', () => {
    expect(extractJson('').ok).toBe(false);
    expect(extractJson('没有任何 JSON').ok).toBe(false);
  });

  it('括号不平衡的非法 JSON 失败而不是返回伪造数据', () => {
    const r = extractJson('{"a":1');
    expect(r.ok).toBe(false);
  });
});

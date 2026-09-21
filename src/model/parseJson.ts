/**
 * 从模型文本输出中稳健提取 JSON：
 * - 去除 ```json 代码围栏；
 * - 截取首个平衡的 {…} / […] 块；
 * - 解析失败给出明确错误，绝不返回伪造数据。
 */

export type JsonExtraction =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function stripCodeFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1] : text;
}

/** 找到与首个开括号匹配的平衡闭括号位置 */
function findBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJson(rawText: string): JsonExtraction {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return { ok: false, message: '模型返回为空' };
  }
  const cleaned = stripCodeFences(rawText).trim();
  // 直接尝试
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    /* 继续做平衡括号提取 */
  }
  const candidate =
    findBalanced(cleaned, '{', '}') ?? findBalanced(cleaned, '[', ']');
  if (!candidate) {
    return { ok: false, message: '模型输出中未找到 JSON 对象' };
  }
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (e) {
    return {
      ok: false,
      message: `JSON 解析失败: ${(e as Error).message}`,
    };
  }
}

import type { RawModelCall } from '../shared/types';

/** 原始模型输出（未解析）与解析结果分开留存 */
export function RawOutputView({ raw }: { raw?: RawModelCall }) {
  if (!raw) return null;
  return (
    <details className="raw">
      <summary>
        原始模型输出（未解析，留存证据）— HTTP {raw.httpStatus} · {raw.startedAt}
      </summary>
      <pre>{raw.rawContent || '(空)'}</pre>
    </details>
  );
}

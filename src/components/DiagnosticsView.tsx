import type { SafeDiagnostics } from '../shared/types';

/** 脱敏诊断：只展示白名单字段，结构上不含 Key、完整请求头或原始请求体 */
export function DiagnosticsView({ diagnostics }: { diagnostics?: SafeDiagnostics }) {
  if (!diagnostics) return null;
  return (
    <div className="diag">
      <b>脱敏诊断</b>（已脱敏，不含 Key / 请求头 / 请求体）：
      <div>
        模型/接入点：{diagnostics.model}（掩码 {diagnostics.endpointMasked}）
      </div>
      {diagnostics.protocol && <div>接口协议：{diagnostics.protocol}</div>}
      {diagnostics.targetUrlMasked && <div>目标地址：{diagnostics.targetUrlMasked}</div>}
      {diagnostics.httpStatus !== undefined && <div>HTTP：{diagnostics.httpStatus}</div>}
      {diagnostics.errorClass && <div>错误分类：{diagnostics.errorClass}</div>}
      {diagnostics.durationMs !== undefined && <div>耗时：{diagnostics.durationMs}ms</div>}
      {diagnostics.requestId && <div>requestId：{diagnostics.requestId}</div>}
      {diagnostics.totalTokens !== undefined && (
        <div>
          Token：prompt {diagnostics.promptTokens ?? '?'} / completion{' '}
          {diagnostics.completionTokens ?? '?'} / 合计 {diagnostics.totalTokens}
        </div>
      )}
    </div>
  );
}

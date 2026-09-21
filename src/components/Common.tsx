import type { SafeError } from '../shared/types';
import { DiagnosticsView } from './DiagnosticsView';
import { RawOutputView } from './RawOutputView';
import type { RawModelCall } from '../shared/types';

export function NotConfiguredGate({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="gate" data-testid="not-configured-gate">
      <h3>当前为等待 / 只读样例状态</h3>
      <p>
        尚未配置火山方舟 API Key 与 Seed Endpoint，不会发起任何模型调用。
        <br />
        配置后即可运行三项探针；你也可以在“只读样例”页查看真实保存的运行结果。
      </p>
      <button type="button" className="btn primary" onClick={onOpenSettings}>
        打开模型设置
      </button>
    </div>
  );
}

const ERROR_HINT: Record<string, string> = {
  'invalid-key': 'API Key 无效或已失效，请检查 Key 是否正确、是否已开通对应模型。',
  quota: '额度不足或触发限流，请检查账户余额/配额后重试。',
  'endpoint-not-found': 'Endpoint 不存在或无权访问，请核对 Seed Endpoint（接入点 ID）。',
  timeout: '请求超时，模型未在限定时间内返回，可稍后重试。',
  network: '网络连接失败，请检查网络或本地代理是否正常。',
  server: '模型服务暂时异常，可稍后重试。',
  'bad-request': '请求被模型服务拒绝，请检查输入。',
  'illegal-json': '模型返回了无法解析的内容（非合法 JSON），本次结果不予采纳。',
  'schema-violation':
    '模型输出未通过 Schema 校验（缺字段/类型错误等），已拒绝，未伪装为成功。',
  'not-configured': '未配置 API Key / Endpoint。',
  'illegal-endpoint': 'Endpoint 不合法：只允许接入点 ID，不允许填写 URL。',
  unknown: '发生未知错误。',
};

export function ErrorOutcome({
  error,
  raw,
}: {
  error: SafeError;
  raw?: RawModelCall;
}) {
  return (
    <div className="errorbox" role="alert" data-testid="error-outcome">
      <div className="cls">
        调用失败 · {error.errorClass}
      </div>
      <div>{ERROR_HINT[error.errorClass] ?? error.message}</div>
      <div style={{ marginTop: 6, fontSize: 12 }}>技术信息：{error.message}</div>
      <DiagnosticsView diagnostics={error.diagnostics} />
      <RawOutputView raw={raw} />
    </div>
  );
}

import { BatchTable } from '../components/batch/BatchTable';
import type { ModelSettings } from '../shared/types';

/**
 * 批量任务页：按已发布版本推导共享/按行输入，同一版本多商品独立执行。
 */
export function BatchPage({
  projectId,
  settings,
  configured,
  onOpenSettings,
}: {
  projectId: string;
  settings: ModelSettings | null;
  configured: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="page-scroll">
      <div className="page-container" style={{ maxWidth: 'none' }}>
        <h1 className="page-title">批量任务</h1>
        <p className="page-sub">
          选择已发布工作流后，页面会按版本自动决定要填哪些输入：参考风格整批共用，商品图按行更换。
        </p>
        <div>
          <BatchTable
            projectId={projectId}
            settings={settings}
            configured={configured}
            onOpenSettings={onOpenSettings}
          />
        </div>
      </div>
    </div>
  );
}

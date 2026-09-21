import { SAVED_RUNS, SAMPLE_POLICY_NOTE } from '../samples/manifest';

/**
 * 只读样例：只展示真实保存的运行。
 * 当前没有真实运行 → 明确显示“等待真实运行”，不伪造任何案例或模拟动画。
 */
export function SampleReadonlyPanel() {
  return (
    <div className="panel">
      <h2>只读样例（真实保存的运行）</h2>
      <p className="desc">
        本页只读取真实模型运行后保存的结果，标注为只读，不会发起新调用，也不播放模拟动画。
      </p>
      <div className="readonly-note" data-testid="sample-waiting">
        {SAMPLE_POLICY_NOTE}
      </div>
      {SAVED_RUNS.length === 0 ? (
        <div className="gate" style={{ marginTop: 12 }}>
          <h3>等待真实运行</h3>
          <p>
            尚未保存任何真实探针运行。配置 API Key 并完成一次真实运行、经核对后，
            结果才会出现在这里。当前不提供任何预置/伪造案例。
          </p>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {SAVED_RUNS.map((run) => (
            <div className="card" key={run.id}>
              <strong>{run.note}</strong>
              <div className="hint">保存于 {run.savedAt}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

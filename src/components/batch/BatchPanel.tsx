/**
 * 阶段3 批量运行页（docs/01 第4节、docs/02 状态/错误隔离、docs/10 阶段3）。
 * 与画布共享同一个 useBatchController（即同一个 WorkflowDefinition）。
 */
import { useMemo, useState } from 'react';
import type { useBatchController } from '../../hooks/useBatchController';
import type { ModelSettings } from '../../shared/types';
import { LIMITS } from '../../shared/constants';
import { ImageUploader } from '../ImageUploader';
import { NotConfiguredGate, ErrorOutcome } from '../Common';
import { estimateBatchBudget, isTerminalState } from '../../batch/batchBudget';
import { groupingValidation } from '../../batch/batchFactory';
import {
  batchProgress,
  itemDisplayState,
  itemRowStats,
  itemStateLabel,
  latestAudit,
  queueStatusLabel,
} from '../../batch/batchQueue';
import { BATCH_MAX_ITEMS, type IdentityMode } from '../../batch/batchConstants';
import type { BatchItem } from '../../batch/batchTypes';
import { IDENTITY_CATEGORY_LABELS } from '../../shared/constants';

type Ctrl = ReturnType<typeof useBatchController>;

function fmtDuration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const IN_FLIGHT = ['analyzing', 'generating', 'auditing', 'repairing'];

export function BatchPanel({
  ctrl,
  settings,
  configured,
  onOpenSettings,
}: {
  ctrl: Ctrl;
  settings: ModelSettings | null;
  configured: boolean;
  onOpenSettings: () => void;
}) {
  const { batch, busy, actionError } = ctrl;
  const versions = ctrl.versions ?? [];
  const [refs, setRefs] = useState(batch?.referenceImages ?? []);
  const [purpose, setPurpose] = useState(batch?.taskPurpose ?? '');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const budget = useMemo(() => (batch ? estimateBatchBudget(batch) : null), [batch]);
  const progress = useMemo(() => (batch ? batchProgress(batch) : null), [batch]);

  if (!configured && !batch) {
    return (
      <div>
        <NotConfiguredGate onOpenSettings={onOpenSettings} />
        <p className="hint" data-testid="batch-readonly-note">
          批量运行需要你自带 Key；未配置时不会发起任何调用，也不会伪造运行结果。
        </p>
      </div>
    );
  }

  // setup / ready 都属于“开跑前准备态”（ready = 已确认预算、等待点击开始）
  const inSetup = !batch || batch.status === 'setup' || batch.status === 'ready';

  return (
    <div className="batch-panel" data-testid="batch-panel">
      {/* ---------------- 准备阶段 ---------------- */}
      {inSetup && (
        <div className="card" data-testid="batch-setup">
          <div className="field">
            <label>执行工作流版本</label>
            {versions.length ? (
              <select
                className="textinput"
                data-testid="batch-workflow-version"
                value={ctrl.selectedVersionId ?? ''}
                onChange={(event) => ctrl.selectVersion(event.target.value)}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.versionNo} · {version.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="hint err">当前项目没有可运行的发布版本，请先在工作流编辑器中发布。</p>
            )}
            {batch?.workflowVersionNo && (
              <p className="hint">本批已锁定 v{batch.workflowVersionNo}，后续草稿修改不会影响本次执行。</p>
            )}
          </div>
          <h2>第一步 · 提取并确认视觉配方（全批共享一道闸门）</h2>
          <ImageUploader
            images={batch?.referenceImages ?? refs}
            setImages={(imgs) => {
              setRefs(imgs);
              ctrl.initFromReferences(imgs, purpose);
            }}
            min={LIMITS.referenceImagesMin}
            max={LIMITS.referenceImagesMax}
            label="参考图"
          />
          <div className="field">
            <label>场景图用途说明（可选）</label>
            <input
              className="textinput"
              data-testid="batch-purpose"
              value={batch?.taskPurpose ?? purpose}
              onChange={(e) => {
                setPurpose(e.target.value);
                if (batch) ctrl.setPurpose(e.target.value);
              }}
              placeholder="例如：电商详情页首屏静物场景图"
            />
          </div>
          {!batch?.recipeConfirmed && (
            <button
              type="button"
              className="btn primary"
              data-testid="extract-recipe"
              disabled={
                busy === 'recipe' ||
                (batch?.referenceImages ?? refs).length < 1 ||
                (!batch?.workflowVersionId && !ctrl.selectedVersionId)
              }
              onClick={() =>
                ctrl.extractRecipe(settings, batch?.referenceImages ?? refs, batch?.taskPurpose ?? purpose)
              }
            >
              {busy === 'recipe' ? '提取中…' : '提取视觉配方'}
            </button>
          )}
          {batch?.recipe && !batch.recipeConfirmed && (
            <div className="gate" data-testid="recipe-gate">
              <h3>请确认视觉配方（第一道人工闸门）</h3>
              <p className="hint">
                已提取 12 个视觉字段。配方只迁移可描述的构图/光线/色彩/背景/氛围规则，不迁移商品身份；
                确认后才允许把商品送入已发布版本。
              </p>
              <button type="button" className="btn primary" data-testid="confirm-recipe" onClick={ctrl.confirmRecipeGate}>
                确认配方并生成工作流
              </button>
            </div>
          )}
          {batch?.recipeConfirmed && (
            <p className="badge confirmed" data-testid="recipe-confirmed-badge">
              视觉配方已确认 · 已绑定发布版本 v{batch.workflowVersionNo ?? '兼容'}
            </p>
          )}

          {batch?.recipeConfirmed && (
            <>
              <h2>第二步 · 上传商品并由你确认分组（最多 {BATCH_MAX_ITEMS} 件，每件 2-3 张）</h2>
              <p className="hint">系统不会自行判断哪些照片属于同一商品——每件商品由你单独建组上传。</p>
              {batch.items.map((item, idx) => (
                <ItemGroupEditor
                  key={item.id}
                  ctrl={ctrl}
                  item={item}
                  index={idx}
                  auditSkipped={batch.skippedNodeIds.includes('resultAuditor')}
                />
              ))}
              {batch.items.length < BATCH_MAX_ITEMS && (
                <button type="button" className="btn" data-testid="add-group" onClick={ctrl.addItemGroup}>
                  ＋ 添加一件商品
                </button>
              )}

              <h2>第三步 · 确认分组与调用成本</h2>
              {(() => {
                const gv = groupingValidation(batch);
                return gv.ok ? (
                  <label className="checkline" data-testid="group-confirm-line">
                    <input
                      type="checkbox"
                      checked={batch.groupingConfirmed}
                      onChange={() => ctrl.confirmGroupingGate()}
                      data-testid="confirm-grouping"
                    />
                    我确认以上 {batch.items.length} 件商品的图片分组与命名正确
                  </label>
                ) : (
                  <p className="hint err" data-testid="group-validation">
                    {gv.reason}
                  </p>
                );
              })()}

              {batch.groupingConfirmed && budget && (
                <div className="budget" data-testid="budget-panel">
                  <div>
                    准备阶段配方提取：<strong>{budget.prepCalls}</strong> 次（已发生）
                  </div>
                  <div>
                    本批预计调用：<strong data-testid="budget-expected">{budget.expected}</strong> 次 ·
                    最坏（每件失败并修复一次）：<strong data-testid="budget-worst">{budget.worst}</strong> 次
                  </div>
                  <ul className="hint">
                    {budget.detail.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                  <label className="checkline">
                    <input
                      type="checkbox"
                      checked={batch.budgetConfirmed}
                      onChange={() => ctrl.confirmBudgetGate()}
                      data-testid="confirm-budget"
                    />
                    我已知晓预计/最坏调用次数（并发：同时分析 2 件、生成 1 件；每件自动修复最多 1 次）
                  </label>
                </div>
              )}

              {batch.budgetConfirmed && (
                <button
                  type="button"
                  className="btn primary"
                  data-testid="start-batch"
                  onClick={() => ctrl.start(settings)}
                >
                  确认成本并开始批量
                </button>
              )}
            </>
          )}
          {actionError && <p className="hint err" data-testid="batch-action-error">{actionError}</p>}
        </div>
      )}

      {/* ---------------- 运行阶段 ---------------- */}
      {batch && !inSetup && (
        <div className="card" data-testid="batch-running">
          <div className="batch-toolbar">
            <div>
              <strong>批量状态：{queueStatusLabel(batch.status)}</strong>
              {progress && (
                <span className="hint" data-testid="batch-progress">
                  {' '}
                  · 通过 {progress.passed} / 警告 {progress.warning} / 待确认 {progress.needsReview} / 失败{' '}
                  {progress.failed} / 跳过 {progress.skipped} / 中断 {progress.interrupted} · 进行中{' '}
                  {progress.inProgress} · 待运行 {progress.pending}
                </span>
              )}
              <div className="hint">
                全批已用调用 <strong data-testid="batch-calls-used">{batch.callsUsed}</strong> / 预算最坏{' '}
                {budget?.worst ?? '—'}（手动重试为你显式触发，不计入自动最坏值）
              </div>
            </div>
            <div className="btn-row">
              {batch.status === 'running' && (
                <button type="button" className="btn" data-testid="pause-all" onClick={ctrl.pauseAll}>
                  暂停整批
                </button>
              )}
              {(batch.status === 'paused' || batch.status === 'system-paused') && (
                <button
                  type="button"
                  className="btn primary"
                  data-testid="resume-all"
                  onClick={() => ctrl.resumeAll(settings)}
                >
                  继续整批
                </button>
              )}
              <button type="button" className="btn" data-testid="batch-reset" onClick={ctrl.reset}>
                新建批次
              </button>
            </div>
          </div>

          {batch.status === 'system-paused' && batch.systemError && (
            <div className="errorbox" role="alert" data-testid="system-paused-banner">
              <strong>系统级错误，已暂停整批（其他商品不受影响结果，进行中的该件已标记中断）：</strong>
              <ErrorOutcome error={batch.systemError} />
              <p className="hint">请处理 Key / 额度 / Endpoint / 网络后，点“继续整批”，并对中断件逐件恢复。</p>
            </div>
          )}
          {batch.status === 'paused' && (
            <p className="badge pending" data-testid="batch-paused-banner">
              整批已暂停：进行中的调用结束后不会发起新调用；刷新页面也不会伪装为仍在运行。
            </p>
          )}

          <table className="batch-table" data-testid="batch-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>图片组</th>
                <th>状态</th>
                <th>当前步骤</th>
                <th>耗时</th>
                <th>调用量</th>
                <th>验收</th>
                <th>问题数</th>
                <th>重试</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {batch.items.map((item) => (
                <BatchRow
                  key={item.id}
                  ctrl={ctrl}
                  item={item}
                  settings={settings}
                  onOpen={() => setDrawerId(item.id)}
                />
              ))}
            </tbody>
          </table>
          {actionError && <p className="hint err">{actionError}</p>}
        </div>
      )}

      {batch && drawerId && (
        <ItemDrawer
          ctrl={ctrl}
          item={batch.items.find((i) => i.id === drawerId)}
          settings={settings}
          onClose={() => setDrawerId(null)}
        />
      )}
    </div>
  );
}

/* ----------------------------- 分组编辑器 ----------------------------- */

function ItemGroupEditor({
  ctrl,
  item,
  index,
  auditSkipped,
}: {
  ctrl: Ctrl;
  item: BatchItem;
  index: number;
  auditSkipped: boolean;
}) {
  void index;
  return (
    <div className="group-editor" data-testid={`group-${item.id}`}>
      <div className="row">
        <input
          className="textinput"
          aria-label={`商品名称 ${item.name}`}
          value={item.name}
          onChange={(e) => ctrl.renameItemGroup(item.id, e.target.value)}
        />
        <button type="button" className="btn" onClick={() => ctrl.removeItemGroup(item.id)}>
          删除该件
        </button>
        <label className="hint">
          身份锁定：
          <select
            value={item.identityMode}
            data-testid={`identity-mode-${item.id}`}
            onChange={(e) => ctrl.setItemIdentityMode(item.id, e.target.value as IdentityMode)}
          >
            <option value="lock">提取后逐件确认（推荐）</option>
            <option value="skip">跳过身份锁定（风险自担）</option>
          </select>
        </label>
      </div>
      <ImageUploader
        images={item.images}
        setImages={(imgs) => ctrl.setItemImages(item.id, imgs)}
        min={2}
        max={3}
        label="同一商品多角度图"
      />
      {auditSkipped && <p className="hint err">结果验收已在画布被全局跳过：该件生成后只能标记“需人工确认”。</p>}
    </div>
  );
}

/* ----------------------------- 批量表格行 ----------------------------- */

function BatchRow({
  ctrl,
  item,
  settings,
  onOpen,
}: {
  ctrl: Ctrl;
  item: BatchItem;
  settings: ModelSettings | null;
  onOpen: () => void;
}) {
  const stats = itemRowStats(item);
  const state = itemDisplayState(item);
  const audit = latestAudit(item);
  const inFlight = typeof state === 'string' && IN_FLIGHT.includes(state);
  const canPause =
    !item.skipped && !item.userPaused && (inFlight || state === 'queued' || state === 'draft' || state === 'pending');
  const canResume = !item.skipped && (item.userPaused || state === 'interrupted');

  return (
    <tr data-testid={`row-${item.id}`} data-state={state}>
      <td>{item.name}</td>
      <td>
        <div className="thumbs mini">
          {item.images.map((img) => (
            <img key={img.id} src={img.dataUri} alt={img.name} title={img.name} />
          ))}
        </div>
      </td>
      <td>
        <span className={`state state-${typeof state === 'string' ? state : ''}`} data-testid={`state-${item.id}`}>
          {itemStateLabel(state)}
        </span>
        {item.awaiting && item.awaiting !== 'accept' && (
          <div className="hint">待人工：{item.awaiting === 'identity' ? '确认身份' : '确认修复'}</div>
        )}
      </td>
      <td>{stats.currentStep ?? '—'}</td>
      <td>{fmtDuration(stats.elapsedMs)}</td>
      <td>{item.wf?.callsUsed ?? 0}</td>
      <td>{audit ? `${audit.status} · ${audit.compositeScore}` : '—'}</td>
      <td>{stats.issueCount}</td>
      <td>{item.retryCount}</td>
      <td>
        <div className="btn-row compact">
          <button type="button" className="btn" onClick={onOpen} data-testid={`view-${item.id}`}>
            查看
          </button>
          {canPause && (
            <button
              type="button"
              className="btn"
              onClick={() => ctrl.pauseItem(item.id)}
              data-testid={`pause-${item.id}`}
            >
              暂停
            </button>
          )}
          {canResume && (
            <button
              type="button"
              className="btn primary"
              onClick={() => ctrl.resumeItem(item.id, settings)}
              data-testid={`resume-${item.id}`}
            >
              继续
            </button>
          )}
          {(state === 'failed' || state === 'interrupted' || item.skipped) && (
            <button
              type="button"
              className="btn"
              onClick={() => ctrl.retryItem(item.id, settings)}
              data-testid={`retry-${item.id}`}
            >
              重试
            </button>
          )}
          {!inFlight && !item.skipped && !isTerminalStateStrict(state) && (
            <button
              type="button"
              className="btn"
              onClick={() => ctrl.skipItem(item.id)}
              data-testid={`skip-${item.id}`}
            >
              跳过
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function isTerminalStateStrict(state: ReturnType<typeof itemDisplayState>): boolean {
  return state === 'passed' || state === 'failed';
}

/* ----------------------------- 单件详情抽屉 ----------------------------- */

function ItemDrawer({
  ctrl,
  item,
  settings,
  onClose,
}: {
  ctrl: Ctrl;
  item?: BatchItem;
  settings: ModelSettings | null;
  onClose: () => void;
}) {
  void settings;
  if (!item) return null;
  const wf = item.wf;
  const awaitingIdentity = item.awaiting === 'identity';
  const awaitingRepair = item.awaiting === 'repair';
  const awaitingAccept = item.awaiting === 'accept';

  return (
    <div className="drawer-mask" onClick={onClose} data-testid="item-drawer">
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{item.name}</h3>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>

        {wf?.lastError && (
          <div className="errorbox" role="alert" data-testid="drawer-error">
            最近错误 · {wf.lastError.errorClass}：{wf.lastError.message}
          </div>
        )}

        {/* 身份锁定闸门 */}
        {wf && wf.identityFeatures.length > 0 && (
          <section data-testid="drawer-identity">
            <h4>商品身份候选（{wf.identityConfirmed ? '已锁定' : '待你确认'}）</h4>
            {wf.identityFeatures.map((f) => (
              <div key={f.id} className={`feat-row ${f.status}`} data-testid={`feat-${f.id}`}>
                <span className="badge">{IDENTITY_CATEGORY_LABELS[f.category] ?? f.category}</span>
                <span className="feat-statement">{f.statement}</span>
                <span className="hint">{f.status}</span>
                {!wf.identityConfirmed && (
                  <span className="btn-row compact">
                    <button
                      type="button"
                      className="btn"
                      data-testid={`feat-confirm-${f.id}`}
                      onClick={() => ctrl.setFeature(item.id, f.id, 'confirmed')}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      className="btn"
                      data-testid={`feat-reject-${f.id}`}
                      onClick={() => ctrl.setFeature(item.id, f.id, 'rejected')}
                    >
                      否决
                    </button>
                  </span>
                )}
              </div>
            ))}
            {awaitingIdentity && (
              <div className="btn-row">
                <button
                  type="button"
                  className="btn primary"
                  data-testid="lock-identity"
                  onClick={() => ctrl.confirmIdentity(item.id)}
                >
                  完成身份锁定并继续
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid="skip-identity"
                  onClick={() => ctrl.skipIdentity(item.id)}
                >
                  跳过身份锁定（风险自担）
                </button>
              </div>
            )}
          </section>
        )}

        {/* 版本与验收 */}
        {wf && wf.attempts.length > 0 && (
          <section data-testid="drawer-attempts">
            <h4>生成版本与验收</h4>
            {wf.attempts.map((a) => (
              <div key={a.id} className="attempt" data-testid={`attempt-${a.id}`}>
                <div className="attempt-head">
                  <strong>v{a.version}</strong>
                  <span className="hint">状态：{a.status}</span>
                </div>
                {a.image && (
                  <img className="genimg" src={a.image.dataUri} alt={`生成 v${a.version}`} data-testid={`genimg-${a.version}`} />
                )}
                {a.audit && (
                  <div className="audit-detail" data-testid={`audit-${a.id}`}>
                    <div className="hint">
                      身份 {a.audit.identityScore} · 配方 {a.audit.recipeScore} · 任务 {a.audit.taskScore} · 技术{' '}
                      {a.audit.technicalScore} · 综合 {a.audit.compositeScore}
                      {a.audit.criticalViolation && <strong className="err"> · 严重错误一票否决</strong>}
                      {a.audit.insufficientEvidence && <span> · 证据不足→需人工确认</span>}
                    </div>
                    <ul>
                      {a.audit.issues.map((iss, i) => (
                        <li key={i} className={`issue ${iss.severity}`} data-testid={`issue-${a.id}-${i}`}>
                          [{iss.dimension}/{iss.severity}] {iss.statement}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {a.repair && (
                  <div className="repair-card" data-testid={`repair-${a.id}`}>
                    <div>
                      <strong>定向修复方案{a.repair.highRisk ? '（高风险，必须人工确认）' : '（低风险）'}</strong>
                    </div>
                    <div className="hint">原因：{a.repair.reason}</div>
                    {a.repair.addedNegative.length > 0 && (
                      <div className="hint">新增负向：{a.repair.addedNegative.join('；')}</div>
                    )}
                    {!a.repair.confirmedAt && awaitingRepair && (
                      <button
                        type="button"
                        className="btn primary"
                        data-testid="apply-repair"
                        onClick={() => ctrl.applyRepair(item.id)}
                      >
                        应用修复并重新生成（仅此一次）
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {awaitingAccept && (
          <div className="btn-row" data-testid="accept-row">
            <button type="button" className="btn primary" data-testid="accept-item" onClick={() => ctrl.acceptItem(item.id)}>
              人工接受该结果（标记通过）
            </button>
            <button type="button" className="btn" onClick={() => ctrl.skipItem(item.id)}>
              不接受，跳过该件
            </button>
          </div>
        )}

        {!wf && <p className="hint">该件尚未开始。</p>}
        {isTerminalState(wf?.state ?? 'draft') && wf?.state !== 'passed' && (
          <p className="hint">该件已到终态（{wf?.state}），可在表格中“重试”或“跳过”。</p>
        )}
      </div>
    </div>
  );
}

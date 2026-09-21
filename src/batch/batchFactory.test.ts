import { describe, expect, it } from 'vitest';
import {
  addGroup,
  confirmBudget,
  confirmGrouping,
  confirmRecipe,
  createBatch,
  groupingValidation,
  removeGroup,
  renameGroup,
  setGroupImages,
  setGroupIdentityMode,
  setRecipe,
  toggleSkippedNode,
  bindWorkflowVersion,
} from './batchFactory';
import { isFixedBackbone } from '../workflow/fixedWorkflow';
import { img, makeRecipe } from './batchTestUtils';
import { BATCH_MAX_ITEMS } from './batchConstants';
import { compileExecutionPlan } from '../workflow/graph/executionPlan';
import { advancedCompatibilityTemplateGraph } from '../workflow/graph/template';

function setup() {
  let b = createBatch([img('r1')], '用途');
  b = setRecipe(b, makeRecipe());
  b = confirmRecipe(b);
  return b;
}

describe('配方闸门与共享 WorkflowDefinition', () => {
  it('未提取配方不能确认', () => {
    const b = createBatch([img('r1')], '');
    expect(() => confirmRecipe(b)).toThrow();
  });
  it('新批次锁定发布版本的计划快照，不再生成旧固定定义', () => {
    const binding = {
      id: 'wfv_project_v3',
      versionNo: 3,
      checksum: 'checksum-3',
      plan: compileExecutionPlan(advancedCompatibilityTemplateGraph()),
    };
    let b = createBatch([img('r1')], '用途', binding);
    b = setRecipe(b, makeRecipe());
    b = confirmRecipe(b);
    expect(b.workflowVersionId).toBe(binding.id);
    expect(b.workflowVersionNo).toBe(3);
    expect(b.workflowPlan).toEqual(binding.plan);
    expect(b.definition).toBeUndefined();
  });

  it('不兼容批量主线的发布计划不能绑定', () => {
    const b = createBatch([img('r1')], '用途');
    expect(() =>
      bindWorkflowVersion(b, {
        id: 'wfv_bad',
        versionNo: 1,
        checksum: 'bad',
        plan: {
          schemaVersion: 1,
          steps: [],
          entryStepIds: [],
          sinkStepIds: [],
          modelCallCount: 0,
        },
      }),
    ).toThrow(/不支持批量运行/);
  });
  it('确认配方后生成固定主干定义，画布与批量共用', () => {
    const b = setup();
    expect(b.recipeConfirmed).toBe(true);
    expect(b.definition).toBeDefined();
    expect(isFixedBackbone(b.definition!)).toBe(true);
    expect(b.definition?.recipeId).toBe('recipe_1');
  });
});

describe('图片分组（系统不自行永久决定归属，docs/01）', () => {
  it('最多 5 件', () => {
    let b = setup();
    for (let i = 0; i < BATCH_MAX_ITEMS; i += 1) b = addGroup(b);
    expect(b.items).toHaveLength(5);
    expect(() => addGroup(b)).toThrow(/最多/);
  });
  it('每件必须 2-3 张，否则不能确认分组', () => {
    let b = addGroup(setup());
    const id = b.items[0].id;
    expect(groupingValidation(b).ok).toBe(false);
    b = setGroupImages(b, id, [img('a')]);
    expect(groupingValidation(b).ok).toBe(false);
    b = setGroupImages(b, id, [img('a'), img('b')]);
    expect(groupingValidation(b).ok).toBe(true);
    expect(() => confirmGrouping(b)).not.toThrow();
  });
  it('名称不能重复', () => {
    let b = addGroup(setup());
    b = addGroup(b);
    b = setGroupImages(b, b.items[0].id, [img('a'), img('b')]);
    b = setGroupImages(b, b.items[1].id, [img('c'), img('d')]);
    b = renameGroup(b, b.items[1].id, b.items[0].name);
    expect(groupingValidation(b).ok).toBe(false);
  });
  it('可删除分组', () => {
    let b = addGroup(setup());
    const id = b.items[0].id;
    b = removeGroup(b, id);
    expect(b.items).toHaveLength(0);
  });
});

describe('画布节点跳过开关', () => {
  it('只允许跳过 identityLock / resultAuditor', () => {
    const b = setup();
    expect(() => toggleSkippedNode(b, 'sceneGenerator')).toThrow(/不可跳过/);
    expect(() => toggleSkippedNode(b, 'referenceInput')).toThrow(/不可跳过/);
    const b2 = toggleSkippedNode(b, 'identityLock');
    expect(b2.skippedNodeIds).toContain('identityLock');
    // 跳过身份锁定 ⇒ 已有分组默认改为 skip
    let b3 = addGroup(b2);
    expect(b3.items[0].identityMode).toBe('skip');
  });
  it('可逐件改回 lock 身份模式', () => {
    let b = addGroup(toggleSkippedNode(setup(), 'identityLock'));
    b = setGroupIdentityMode(b, b.items[0].id, 'lock');
    expect(b.items[0].identityMode).toBe('lock');
  });
});

describe('开始前预算确认', () => {
  it('未确认分组不能确认预算', () => {
    const b = setup();
    expect(() => confirmBudget(b)).toThrow();
  });
  it('完整流程进入 ready', () => {
    let b = addGroup(setup());
    b = setGroupImages(b, b.items[0].id, [img('a'), img('b'), img('c')]);
    b = confirmGrouping(b);
    b = confirmBudget(b);
    expect(b.status).toBe('ready');
    expect(b.budgetConfirmed).toBe(true);
  });
});

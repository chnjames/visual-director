import { beforeEach, describe, expect, it } from 'vitest';
import { buildReadyBatch } from '../batch/batchTestUtils';
import { createWorkflow } from '../workflow/orchestrator';
import { compilePrompt } from '../workflow/promptCompiler';
import { clearAssets, listAssets } from './assetStore';
import { persistBatchItemRun } from './persistBatchItemRun';
import { clearRuns, listRuns } from './runStore';

const PID = 'test-batch-run-projection';

describe('persistBatchItemRun', () => {
  beforeEach(async () => {
    await clearRuns(PID);
    await clearAssets(PID);
  });

  it('把批量商品终态幂等投影到统一 run 与 assets', async () => {
    const batch = buildReadyBatch(1, { identityMode: 'skip' });
    batch.workflowVersionId = 'wfv_project_v2';
    batch.workflowVersionNo = 2;
    const item = batch.items[0];
    const wf = createWorkflow({
      referenceImages: batch.referenceImages,
      productImages: item.images,
      taskPurpose: batch.taskPurpose,
      name: item.name,
    });
    wf.state = 'passed';
    wf.callsUsed = 2;
    wf.recipeConfirmed = true;
    wf.attempts = [
      {
        id: 'att_1',
        version: 1,
        status: 'passed',
        prompt: compilePrompt(batch.recipe!, [], batch.taskPurpose),
        image: {
          id: 'img_1',
          mediaType: 'image/png',
          dataUri: 'data:image/png;base64,batch',
        },
      },
    ];
    item.wf = wf;

    await persistBatchItemRun(PID, batch, item);
    await persistBatchItemRun(PID, batch, item);

    const runs = await listRuns(PID);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'batch-item',
      workflowVersionId: 'wfv_project_v2',
      workflowVersionNo: 2,
      batchId: batch.id,
      itemId: item.id,
    });
    const assets = await listAssets(PID);
    expect(assets).toHaveLength(1);
    expect(assets[0].source).toBe('batch');
    expect(assets[0].runId).toBe(runs[0].id);
  });
});

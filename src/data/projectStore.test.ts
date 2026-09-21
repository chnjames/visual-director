import { describe, expect, it } from 'vitest';
import { createProject, deleteProject, listProjects, updateProject } from './projectStore';
import { DEFAULT_GENERATION_DEFAULTS } from '../workflow/generationOptions';

describe('projectStore 项目设置', () => {
  it('可更新名称、备注和生成默认值', async () => {
    const project = await createProject('原名', '旧备注');
    const next = await updateProject(project.id, {
      name: '  新名称  ',
      note: '  新备注  ',
      generationDefaults: {
        aspectRatio: '16:9',
        resolution: '3K',
        count: 4,
        targetUse: 'banner',
      },
    });
    expect(next).not.toBeNull();
    expect(next!.name).toBe('新名称');
    expect(next!.note).toBe('新备注');
    expect(next!.generationDefaults).toEqual({
      aspectRatio: '16:9',
      resolution: '3K',
      count: 4,
      targetUse: 'banner',
    });
    const listed = (await listProjects()).find((p) => p.id === project.id);
    expect(listed?.name).toBe('新名称');
    expect(listed?.generationDefaults?.aspectRatio).toBe('16:9');
  });

  it('空名称不覆盖原名；非法生成默认值回落到出厂值', async () => {
    const project = await createProject('保留名');
    const next = await updateProject(project.id, {
      name: '   ',
      generationDefaults: {
        aspectRatio: 'nope',
        resolution: '2K',
        count: 99,
        targetUse: '??',
      },
    });
    expect(next).not.toBeNull();
    expect(next!.name).toBe('保留名');
    expect(next!.generationDefaults).toEqual({
      ...DEFAULT_GENERATION_DEFAULTS,
      count: 4,
      resolution: '2K',
    });
  });

  it('删除项目后列表中不再出现', async () => {
    const project = await createProject('待删');
    await deleteProject(project.id);
    expect((await listProjects()).some((p) => p.id === project.id)).toBe(false);
  });
});

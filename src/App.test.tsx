import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = '/projects';
});

describe('产品官网首页（#/）', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('空 hash 落到官网：完整可读，无 Key 也不崩溃', async () => {
    render(<App />);
    await settle();

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    // 所有“进入工作台”CTA 存在
    expect(screen.getAllByRole('button', { name: /进入工作台/ }).length).toBeGreaterThan(0);
    // 官网不渲染工作台的新建项目入口
    expect(screen.queryByTestId('new-project')).toBeNull();
  });

  it('点击进入工作台直达项目首页', async () => {
    render(<App />);
    await settle();

    fireEvent.click(screen.getAllByRole('button', { name: /进入工作台/ })[0]);
    await settle();

    expect(window.location.hash).toBe('#/projects');
    expect(screen.getByTestId('new-project')).toBeInTheDocument();
  });
});

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

/** 走真实“新建项目”对话框创建一个标准模板项目并进入画布 */
async function createDefaultProject() {
  fireEvent.click(screen.getByTestId('new-project'));
  fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: '默认项目' } });
  fireEvent.click(screen.getByTestId('new-project-create'));
  await settle();
  await settle();
}

describe('新信息架构：项目首页 → 项目 Shell → 画布', () => {
  it('默认进入项目首页：首次使用空状态 + 新建项目，无旧版七个 Tab', async () => {
    render(<App />);
    await settle();

    expect(screen.getByTestId('new-project')).toBeInTheDocument();
    expect(screen.getByTestId('first-use-empty')).toBeInTheDocument();
    // 旧探针 Tab 结构已移除
    expect(screen.queryByRole('button', { name: 'A 视觉配方' })).toBeNull();
    expect(screen.queryByRole('button', { name: '只读样例' })).toBeNull();
  });

  it('新建项目：先选模板才创建，进入专注式画布', async () => {
    render(<App />);
    await settle();

    // 点击新建 → 弹出模板选择对话框，尚未进入项目
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-project'));
    });
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBeInTheDocument();
    expect(screen.getByTestId('new-project-create')).toBeDisabled();

    // 填名称，默认标准模板
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: '测试项目' } });
    expect(screen.getByTestId('new-project-create')).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-project-create'));
    });
    await settle();
    await settle();

    expect(screen.getByTestId('project-shell')).toBeInTheDocument();
    expect(screen.getByTestId('sidenav')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-editor')).toBeInTheDocument();
    expect(screen.getByTestId('flow-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('open-node-library')).toBeInTheDocument();

    const nodeTypes = [
      'referenceAnalyze',
      'productImages',
      'promptEditor',
      'sceneGenerate',
      'resultGallery',
    ];
    for (const type of nodeTypes) {
      expect(screen.getAllByTestId(new RegExp(`^node-${type}-`)).length).toBeGreaterThan(0);
    }
    expect(screen.queryByTestId('node-inspector')).toBeNull();
    // 收窄导航轨
    expect(screen.getByLabelText('工作流')).toBeInTheDocument();
    expect(screen.getByLabelText('批量任务')).toBeInTheDocument();
    expect(screen.getByLabelText('素材')).toBeInTheDocument();
    expect(screen.getByLabelText('运行记录')).toBeInTheDocument();
  });

  it('可选择空白模板：只创建最小开始/定稿节点，不塞入整条流程', async () => {
    render(<App />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-project'));
    });
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: '空白项' } });
    fireEvent.click(screen.getByTestId('template-blank'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-project-create'));
    });
    await settle();
    await settle();
    // 直接生成模板只有商品场景生成 + 结果展示
    expect(document.querySelectorAll('.flow-node').length).toBe(2);
    const runBtn = screen.getByTestId('run-workflow') as HTMLButtonElement;
    expect(runBtn.disabled).toBe(false);
    expect(screen.getByTestId('canvas-toolbar')).toBeInTheDocument();
    fireEvent.click(screen.getByText('尚未上传商品图'));
    await settle();
    expect(screen.getByTestId('inspector-run-node')).toBeInTheDocument();
  });

  it('无 Key：试运行不打开弹窗，直接在节点上提示并引导设置', async () => {
    render(<App />);
    await settle();
    await createDefaultProject();

    expect(screen.getByTestId('model-status').textContent).toContain('未连接');
    const runBtn = screen.getByTestId('run-workflow') as HTMLButtonElement;
    expect(runBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(runBtn);
    });
    await settle();
    expect(screen.queryByTestId('testrun-drawer')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-modal')).toBeInTheDocument();
    expect(screen.getAllByText(/尚未配置文本模型/).length).toBeGreaterThan(0);
  });

  it('侧栏可切换到批量/素材/运行记录页，运行记录显示空态而非崩溃', async () => {
    render(<App />);
    await settle();
    await createDefaultProject();

    fireEvent.click(screen.getByLabelText('运行记录'));
    await settle();
    expect(screen.getByText('运行记录', { selector: '.page-title' })).toBeInTheDocument();
    expect(screen.getByText('还没有运行记录')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('素材'));
    await settle();
    expect(screen.getByText('素材库', { selector: '.page-title' })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('批量任务'));
    await settle();
    expect(screen.getByTestId('batch-table')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('设置'));
    await settle();
    expect(screen.getByTestId('project-shell')).toBeInTheDocument();
    expect(screen.getByTestId('sidenav')).toBeInTheDocument();
    expect(screen.getByText('设置', { selector: '.page-title' })).toBeInTheDocument();
    expect(screen.getByLabelText('工作流')).toBeInTheDocument();
  });

  it('在设置中保存 Key：Key 只进入 sessionStorage，画布模型状态变为已连接', async () => {
    const SECRET = 'sk-ui-secret-7777';
    render(<App />);
    await settle();

    fireEvent.click(screen.getByTestId('open-settings'));
    await settle();
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    expect(screen.getByTestId('settings-form')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-project')).toBeNull();
    fireEvent.change(screen.getByTestId('image-apikey-input'), { target: { value: SECRET } });
    fireEvent.click(screen.getByTestId('use-seedream-5'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await settle();

    fireEvent.click(screen.getByText('← 项目'));
    await settle();
    await waitFor(() => {
      expect(screen.getByTestId('model-connection').textContent).toContain('已连接');
    });

    let inSession = false;
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i) as string;
      if ((sessionStorage.getItem(k) ?? '').includes(SECRET)) inSession = true;
    }
    expect(inSession).toBe(true);

    let inLocal = false;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i) as string;
      if ((localStorage.getItem(k) ?? '').includes(SECRET)) inLocal = true;
    }
    expect(inLocal).toBe(false);
  });

  it('点击节点会打开覆盖检查器并显示核心节点定义与端口', async () => {
    render(<App />);
    await settle();
    await createDefaultProject();

    const node = screen.getAllByTestId(/^node-referenceAnalyze-/)[0] as HTMLElement;
    const head = node.querySelector('.fn-head') as HTMLElement;
    await act(async () => {
      fireEvent.click(head ?? node);
    });
    await settle();

    const inspector = screen.getByTestId('node-inspector');
    expect(inspector).toBeInTheDocument();
    expect(inspector.textContent).toContain('参考图分析');
    expect(inspector.textContent).toContain('参考图');
    expect(inspector.textContent).toContain('用途');
  });

  it('点击生成节点摘要（非标题栏）也会打开检查器', async () => {
    render(<App />);
    await settle();
    await createDefaultProject();

    const summary = await screen.findByText('商品图来自上游，尚未上传');
    await act(async () => {
      fireEvent.click(summary);
    });
    await settle();

    const inspector = screen.getByTestId('node-inspector');
    expect(inspector).toBeInTheDocument();
    expect(inspector.textContent).toContain('商品场景生成');
  });

  it('更多菜单只保留设置，进入项目/模型/生成默认值三组', async () => {
    render(<App />);
    await settle();
    await createDefaultProject();

    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    expect(screen.getByTestId('menu-settings')).toHaveTextContent('设置');
    expect(screen.queryByRole('menuitem', { name: '模型设置' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '所有设置' })).toBeNull();
    fireEvent.click(screen.getByTestId('menu-settings'));
    await settle();

    expect(screen.getByTestId('settings-project')).toBeInTheDocument();
    expect(screen.getByTestId('settings-model')).toBeInTheDocument();
    expect(screen.getByTestId('settings-generation')).toBeInTheDocument();
  });

  it('可改项目名称，顶栏立即更新；状态灯进入模型连接', async () => {
    render(<App />);
    await settle();
    await createDefaultProject();

    fireEvent.click(screen.getByTestId('model-status'));
    await settle();
    expect(window.location.hash).toMatch(/settings\?section=model/);
    expect(screen.getByTestId('settings-model')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: '改过名的项目' } });
    fireEvent.change(screen.getByTestId('project-note-input'), { target: { value: '主图场景' } });
    fireEvent.click(screen.getByTestId('save-project-info'));
    await settle();
    expect(screen.getByTestId('shell-project-name')).toHaveTextContent('改过名的项目');
  });

  it('生成默认值只作用于之后新加入的商品场景生成节点', async () => {
    render(<App />);
    await settle();
    await createDefaultProject();

    fireEvent.click(screen.getByLabelText('设置'));
    await settle();
    fireEvent.change(screen.getByTestId('gen-aspect'), { target: { value: '16:9' } });
    fireEvent.change(screen.getByTestId('gen-resolution'), { target: { value: '3K' } });
    fireEvent.change(screen.getByTestId('gen-count'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('gen-target-use'), { target: { value: 'banner' } });
    fireEvent.click(screen.getByTestId('save-generation-defaults'));
    await settle();

    fireEvent.click(screen.getByLabelText('工作流'));
    await settle();
    fireEvent.click(screen.getByTestId('open-node-library'));
    fireEvent.click(screen.getByTestId('add-node-sceneGenerate'));
    await settle();

    await waitFor(() => {
      expect(screen.getByTestId('cfg-aspectRatio').querySelector('[aria-pressed="true"]')?.textContent).toContain('16:9');
    });
    expect(screen.getByTestId('cfg-resolution').querySelector('[aria-pressed="true"]')?.textContent).toContain('3K');
    expect(screen.getByTestId('cfg-count')).toHaveValue(3);
    expect(screen.getByTestId('cfg-targetUse')).toHaveValue('banner');
  });
});

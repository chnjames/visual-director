import { useEffect, useState } from 'react';
import { HashRouter, buildPath, useRouter, navigate } from './router/hashRouter';
import { useModelSettings } from './hooks/useModelSettings';
import { ModelSettingsModal } from './components/ModelSettingsModal';
import { ProjectShell } from './components/shell/ProjectShell';
import { ProjectsPage } from './pages/ProjectsPage';
import { LandingPage } from './pages/LandingPage';
import { WorkflowEditorPage, type CanvasChrome } from './pages/WorkflowEditorPage';
import { BatchPage } from './pages/BatchPage';
import { AssetsPage } from './pages/AssetsPage';
import { RunsPage } from './pages/RunsPage';
import { SettingsPage } from './pages/SettingsPage';
import { listProjects, ensureMigrationProject, type Project } from './data/projectStore';
import { migrateLegacyDocs } from './data/db';
import type { ModelSettings } from './shared/types';

/**
 * 应用根（docs/11 §2 路由）：
 *   /projects · /projects/:id/{canvas,batch,assets,runs} · /settings
 * 旧版七个平级 Tab 的产品结构已移除；探针能力迁入画布节点检查器。
 */
export default function App() {
  return (
    <HashRouter>
      <Root />
    </HashRouter>
  );
}

function Root() {
  const { route } = useRouter();
  const { settings, configured, save, clear } = useModelSettings();
  const [modalOpen, setModalOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    void migrateLegacyDocs(async (id) => {
      await ensureMigrationProject(id);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void listProjects().then((p) => {
      if (alive) setProjects(p);
    });
    return () => {
      alive = false;
    };
  }, [route.name]);

  const modal = (
    <ModelSettingsModal
      open={modalOpen}
      initial={settings}
      onSave={save}
      onClear={clear}
      onClose={() => setModalOpen(false)}
    />
  );
  const openSettings = () => setModalOpen(true);

  if (route.name === 'landing') {
    return <LandingPage />;
  }

  if (route.name === 'projects') {
    return (
      <>
        <ProjectsPage settings={settings} configured={configured} />
        {modal}
      </>
    );
  }

  if (route.name === 'settings-global') {
    return (
      <SettingsPage
        settings={settings}
        onSave={save}
        onClear={clear}
      />
    );
  }

  if (route.name === 'unknown') {
    return (
      <div className="home">
        <div className="home-inner">
          <div className="empty-state">
            <h3>页面不存在</h3>
            <p>没有这个地址。</p>
            <div className="btn-row">
              <button type="button" className="btn primary" onClick={() => navigate(buildPath('projects'))}>
                返回项目首页
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ProjectRoute
      route={route}
      projects={projects}
      settings={settings}
      configured={configured}
      onOpenSettings={openSettings}
      onSaveSettings={save}
      onClearSettings={clear}
      modal={modal}
    />
  );
}

function ProjectRoute({
  route,
  projects,
  settings,
  configured,
  onOpenSettings,
  onSaveSettings,
  onClearSettings,
  modal,
}: {
  route: { name: 'canvas' | 'batch' | 'assets' | 'runs' | 'settings'; projectId: string };
  projects: Project[] | null;
  settings: ModelSettings | null;
  configured: boolean;
  onOpenSettings: () => void;
  onSaveSettings: (s: ModelSettings) => void;
  onClearSettings: () => void;
  modal: React.ReactNode;
}) {
  const { projectId, name: section } = route;
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [canvasChrome, setCanvasChrome] = useState<CanvasChrome | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let alive = true;
    setResolved(false);
    void listProjects().then((list) => {
      if (!alive) return;
      const found = list.find((p) => p.id === projectId) ?? null;
      setProject(found);
      setResolved(true);
      if (!found) navigate(buildPath('projects'));
    });
    return () => {
      alive = false;
    };
  }, [projectId, projects]);

  if (!resolved || !project) {
    return (
      <div className="home">
        <div className="home-inner">
          <div className="empty-state">
            <h3>正在打开项目…</h3>
            <p className="hint">如果项目不存在或已被删除，将自动返回项目首页。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ProjectShell
      project={project}
      settings={settings}
      configured={configured}
      saveState={saveState}
      savedAt={savedAt}
      canvasChrome={section === 'canvas' ? canvasChrome : null}
    >
      {section === 'canvas' && (
        <WorkflowEditorPage
          projectId={projectId}
          projectName={project.name}
          generationDefaults={project.generationDefaults}
          configured={configured}
          settings={settings}
          onOpenSettings={onOpenSettings}
          onSaveState={(s, at) => {
            setSaveState(s);
            if (at !== undefined) setSavedAt(at);
          }}
          onCanvasChrome={setCanvasChrome}
        />
      )}
      {section === 'batch' && (
        <BatchPage
          projectId={projectId}
          settings={settings}
          configured={configured}
          onOpenSettings={onOpenSettings}
        />
      )}
      {section === 'assets' && (
        <AssetsPage projectId={projectId} settings={settings} configured={configured} />
      )}
      {section === 'runs' && <RunsPage projectId={projectId} />}
      {section === 'settings' && (
        <SettingsPage
          settings={settings}
          onSave={onSaveSettings}
          onClear={onClearSettings}
          project={project}
          onProjectChange={setProject}
        />
      )}
      {section !== 'settings' && modal}
    </ProjectShell>
  );
}

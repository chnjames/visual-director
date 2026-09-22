/**
 * 产品官网首页（docs/16）：纯展示与入口，不读取项目数据、不需要 Key。
 * 注意：项目使用 hash 路由，页内锚点不能写 href="#xxx"（会被当成路由），
 * 统一用 scrollToId 做平滑滚动，不修改 location.hash。
 */
import {
  ScanSearch,
  BadgeCheck,
  FileText,
  ImagePlus,
  ClipboardCheck,
  Wrench,
  Workflow,
  Layers,
  Lock,
  HardDrive,
  ShieldCheck,
  ArrowRight,
  FlaskConical,
  PackageCheck,
  LayoutGrid,
} from 'lucide-react';
import { buildPath, useRouter } from '../router/hashRouter';
import './landing.css';

const PAINS = [
  {
    title: '批量出图，风格却对不齐',
    desc: '同一批商品图光影、色调、构图各不相同，无法沉淀成可复用的标准。',
    value: '把参考图拆成可复用的「视觉配方」，确认一次，整批复用。',
  },
  {
    title: '商品被改形、换件、加 Logo',
    desc: '模型自由发挥后瓶型走样、材质变了、多出不存在的部件或文字。',
    value: '商品身份单独锁定，生成后做四维验收，严重错误一票否决。',
  },
  {
    title: '黑盒提示词，无法追溯',
    desc: '不知道模型依据了什么，出错只能反复重roll，团队无法交接。',
    value: '每个字段附带置信度与图像证据，关键节点必须人工确认。',
  },
];

const FEATURES = [
  {
    icon: ScanSearch,
    title: '参考图分析与视觉配方',
    desc: '上传 1–5 张参考图，解析为光影、色调、构图、背景等结构化字段，每个字段含置信度与图像证据；只描述画面，不猜测原图提示词。',
  },
  {
    icon: BadgeCheck,
    title: '商品身份锁定',
    desc: '从 2–3 张多角度商品图提取形状、部件、颜色、材质、Logo、纹理候选；模型建议默认待确认，你确认后才成为不可改变的硬约束。',
  },
  {
    icon: FileText,
    title: '结构化提示词确认',
    desc: '提示词由已确认的配方与身份编译生成、只读可核对；自由文本不能反向覆盖已确认的结构，避免一句话冲掉全部约束。',
  },
  {
    icon: ImagePlus,
    title: '商品场景生成',
    desc: '按渠道选择画幅比例、分辨率与出图数量，把商品放进符合配方的场景中；生成通道独立配置，未配置时其余功能照常可用。',
  },
  {
    icon: ClipboardCheck,
    title: '四维结果验收',
    desc: '从商品身份、视觉配方、场景任务、技术质量四个维度检查；严重错误直接判失败，证据不足一律标记为需人工复核，不强行通过。',
  },
  {
    icon: Wrench,
    title: '定向修复',
    desc: '验收失败时只针对问题点做一次定向修复并重新生成；形态、Logo、材质、虚构文字等高风险问题必须停车由你确认。',
  },
];

const SCENARIOS = [
  {
    icon: FlaskConical,
    title: '静物电商主图',
    desc: '香薰、陶瓷、摆件等静物商品的主图与场景图，统一光影与背景风格。',
  },
  {
    icon: LayoutGrid,
    title: '详情页场景图',
    desc: '为同一商品批量产出不同构图、不同渠道比例的详情页配图。',
  },
  {
    icon: PackageCheck,
    title: '一组 SKU 批量换景',
    desc: '同一套已发布工作流复用于多个商品，参考风格整批共用，商品按行更换。',
  },
];

const STEPS = [
  {
    n: '01',
    title: '上传参考图与商品图',
    desc: '1–5 张参考图决定画面风格，2–3 张多角度商品图决定“不能改变什么”。',
  },
  {
    n: '02',
    title: '确认两道闸门',
    desc: '逐字段确认视觉配方与商品身份；模型只给候选，确认后才成为事实。',
  },
  {
    n: '03',
    title: '单件试运行看证据',
    desc: '先跑通一件商品，查看编译后的提示词、生成结果与四维验收结论。',
  },
  {
    n: '04',
    title: '发布版本并批量出图',
    desc: '校验通过后发布为不可变版本，按版本开批，最多 5 件、失败可隔离恢复。',
  },
];

const FAQS = [
  {
    q: '需要写代码吗？',
    a: '不需要。所有能力都是画布上的封闭节点：上传、分析、确认、编译、生成、验收、修复、定稿。不能自定义脚本、表达式或新增节点类型，避免不可控的自动化。',
  },
  {
    q: '会自由联网或抓取图片吗？',
    a: '不会。产品没有任意 HTTP / 抓取节点，图片只从本机内联上传；模型请求经本地同源代理转发，目标主机被限定为火山方舟官方域名。',
  },
  {
    q: '支持哪些商品？',
    a: '首版面向静物电商：陶瓷、花瓶、香薰、摆件等。不做人像换装、复杂包装文字渲染等场景，超出边界的任务请以验收结论为准。',
  },
  {
    q: '批量一次能跑多少？失败怎么办？',
    a: '每批最多 5 件商品、每件 2–3 张图。单个商品的错误只影响该商品；密钥、额度、服务端等系统错误会让整批暂停；刷新页面时在途任务一律判为中断，需要你显式恢复，不会假装继续运行。',
  },
  {
    q: '我的图片和数据存在哪里？',
    a: '全部保存在本机浏览器（IndexedDB），没有云数据库和账号体系。API Key 只存在当前标签页会话中，关闭即清除，不写入磁盘、日志或导出文件。',
  },
  {
    q: '验收分数是行业标准吗？',
    a: '不是。四个维度的权重与一票否决规则是本产品的判定规则，用于把问题显式化；所有最终结果仍需你人工核验后再使用。',
  },
];

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function LandingPage() {
  const { navigate } = useRouter();
  const enterWorkbench = () => navigate(buildPath('projects'));

  return (
    <div className="lp">
      {/* 顶部导航 */}
      <header className="lp-nav">
        <div className="lp-container lp-nav-inner">
          <button type="button" className="lp-brand" onClick={() => window.scrollTo({ top: 0 })}>
            <span className="lp-brand-mark" aria-hidden>
              <Workflow size={16} />
            </span>
            Visual Director
            <span className="lp-brand-sub">视觉配方工厂</span>
          </button>
          <nav className="lp-nav-links" aria-label="页面导航">
            <button type="button" onClick={() => scrollToId('features')}>核心功能</button>
            <button type="button" onClick={() => scrollToId('scenarios')}>适用场景</button>
            <button type="button" onClick={() => scrollToId('flow')}>操作流程</button>
            <button type="button" onClick={() => scrollToId('workflow')}>工作流复用</button>
            <button type="button" onClick={() => scrollToId('safety')}>数据与安全</button>
            <button type="button" onClick={() => scrollToId('faq')}>常见问题</button>
          </nav>
          <button type="button" className="btn primary lp-cta-top" onClick={enterWorkbench}>
            进入工作台
            <ArrowRight size={15} />
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-container lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">本地优先 · 自带 Key · 人在环上</span>
            <h1>把参考图变成可确认、可复用的视觉配方，再安全地批量出图</h1>
            <p className="lp-lead">
              Visual Director 是面向静物电商的视觉生产工作台：先让模型说清“画面由什么构成”，
              经你确认后再生成、逐张验收，最后把同一套已发布工作流复用于整批商品。
            </p>
            <div className="lp-hero-actions">
              <button type="button" className="btn primary lp-cta-lg" onClick={enterWorkbench}>
                进入工作台
                <ArrowRight size={16} />
              </button>
              <button type="button" className="btn lp-cta-ghost" onClick={() => scrollToId('flow')}>
                查看工作流程
              </button>
            </div>
            <ul className="lp-hero-points">
              <li>模型只给建议，关键事实由你确认</li>
              <li>每一步都有图像证据与验收结论</li>
              <li>数据留在本机，Key 只在当前会话</li>
            </ul>
          </div>

          {/* 静态节点流示意（非假数据、无动画） */}
          <div className="lp-hero-flow" aria-label="工作流结构示意">
            <div className="lp-flow-side">
              <div className="lp-flow-card compact">
                <strong>商品图</strong>
                <small>2–3 张多角度</small>
              </div>
              <span className="lp-flow-hlink" aria-hidden />
            </div>
            <div className="lp-flow-chain">
              <div className="lp-flow-card">
                <span className="lp-flow-tag">输入</span>
                <strong>参考图分析</strong>
                <small>1–5 张参考图 → 视觉配方</small>
              </div>
              <div className="lp-flow-link" aria-hidden />
              <div className="lp-flow-card">
                <span className="lp-flow-tag gate">人工确认</span>
                <strong>配方 / 身份确认</strong>
                <small>候选 → 硬约束</small>
              </div>
              <div className="lp-flow-link" aria-hidden />
              <div className="lp-flow-card">
                <span className="lp-flow-tag">生成</span>
                <strong>商品场景生成</strong>
                <small>比例 · 分辨率 · 数量</small>
              </div>
              <div className="lp-flow-link" aria-hidden />
              <div className="lp-flow-card">
                <span className="lp-flow-tag audit">验收</span>
                <strong>四维结果验收</strong>
                <small>通过 / 需复核 / 失败</small>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 痛点 → 价值 */}
      <section className="lp-section">
        <div className="lp-container">
          <h2 className="lp-h2">先解决三个反复出现的问题</h2>
          <div className="lp-pain-grid">
            {PAINS.map((p) => (
              <article className="lp-card lp-pain" key={p.title}>
                <p className="lp-pain-problem">{p.title}</p>
                <p className="lp-muted">{p.desc}</p>
                <div className="lp-pain-arrow" aria-hidden>
                  <ArrowRight size={15} />
                </div>
                <p className="lp-pain-value">{p.value}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* 核心功能 */}
      <section className="lp-section lp-section-tint" id="features">
        <div className="lp-container">
          <h2 className="lp-h2">核心功能</h2>
          <p className="lp-section-sub">
            从参考图分析、提示词确认、商品场景生成，到工作流复用与批量处理，每个环节都可检查、可追溯。
          </p>
          <div className="lp-feature-grid">
            {FEATURES.map((f) => (
              <article className="lp-card lp-feature" key={f.title}>
                <span className="lp-feature-icon" aria-hidden>
                  <f.icon size={19} />
                </span>
                <h3>{f.title}</h3>
                <p className="lp-muted">{f.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* 适用场景 */}
      <section className="lp-section" id="scenarios">
        <div className="lp-container">
          <h2 className="lp-h2">适用场景</h2>
          <div className="lp-scenario-grid">
            {SCENARIOS.map((s) => (
              <article className="lp-card lp-scenario" key={s.title}>
                <span className="lp-feature-icon" aria-hidden>
                  <s.icon size={19} />
                </span>
                <h3>{s.title}</h3>
                <p className="lp-muted">{s.desc}</p>
              </article>
            ))}
          </div>
          <p className="lp-boundary">
            首版边界：面向陶瓷、花瓶、香薰、摆件等静物商品；不做人像换装与复杂包装文字渲染。
          </p>
        </div>
      </section>

      {/* 操作流程 */}
      <section className="lp-section lp-section-tint" id="flow">
        <div className="lp-container">
          <h2 className="lp-h2">操作流程</h2>
          <ol className="lp-steps">
            {STEPS.map((s) => (
              <li className="lp-step" key={s.n}>
                <span className="lp-step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p className="lp-muted">{s.desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 工作流复用（真实画布截图） */}
      <section className="lp-section" id="workflow">
        <div className="lp-container lp-split">
          <div className="lp-split-copy">
            <span className="lp-eyebrow"><Workflow size={14} /> 工作流复用</span>
            <h2 className="lp-h2">画布上编排，发布成版本再复用</h2>
            <p className="lp-muted">
              在可视化画布上增删、连接节点并保存草稿；图校验会标出类型不兼容、绕过确认闸门、修复超限等问题。
              校验通过后才能发布为<strong>不可变版本</strong>，试运行与批量只引用已发布版本，画布改动不会影响正在跑的任务。
            </p>
            <ul className="lp-check-list">
              <li>封闭节点体系：无代码节点、无任意联网、无循环</li>
              <li>类型化端口：接错线即时提示，问题分错误 / 警告 / 建议三级</li>
              <li>出厂模板：直接生成、参考图辅助生成，开箱即用</li>
            </ul>
          </div>
          <figure className="lp-shot">
            <img src="/screenshots/canvas.png" alt="Visual Director 可视化工作流画布：参考图分析、提示词编辑、商品场景生成与结果展示节点" loading="lazy" />
            <figcaption>可视化工作流画布（产品实际界面）</figcaption>
          </figure>
        </div>

        <div className="lp-container lp-split lp-split-reverse">
          <div className="lp-split-copy">
            <span className="lp-eyebrow"><Layers size={14} /> 批量处理</span>
            <h2 className="lp-h2">同一版本，多件商品受控批量</h2>
            <p className="lp-muted">
              开跑前明示预计与最坏调用次数，确认后才开始：分析最多并发 2 件、生成并发 1 件，
              支持暂停、继续、跳过与手动重试。商品级错误互不影响，系统级错误整批暂停，刷新不伪装运行。
            </p>
            <ul className="lp-check-list">
              <li>每批最多 5 件，每件 2–3 张多角度商品图</li>
              <li>参考风格整批共用，商品图按行更换</li>
              <li>每件最多定向修复一次，高风险问题停车确认</li>
            </ul>
          </div>
          <figure className="lp-shot">
            <img src="/screenshots/batch.png" alt="批量任务页：选择已发布工作流版本、商品行表格与开始批量入口" loading="lazy" />
            <figcaption>批量任务页：只对已发布版本开批（产品实际界面）</figcaption>
          </figure>
        </div>
      </section>

      {/* 实际界面 */}
      <section className="lp-section lp-section-tint">
        <div className="lp-container">
          <h2 className="lp-h2">实际界面</h2>
          <p className="lp-section-sub">
            工作台按项目组织：每个项目保存自己的画布、素材、运行记录与批量任务。以下为产品实际界面截图，
            不含模拟生成结果；真实出图需要使用你自己的模型接入点。
          </p>
          <figure className="lp-shot lp-shot-wide">
            <img src="/screenshots/projects.png" alt="工作台项目首页：项目卡片、状态筛选与新建项目入口" loading="lazy" />
            <figcaption>工作台项目首页（产品实际界面）</figcaption>
          </figure>
        </div>
      </section>

      {/* 数据与安全 */}
      <section className="lp-section" id="safety">
        <div className="lp-container">
          <h2 className="lp-h2">自带 Key，数据留在本机</h2>
          <div className="lp-safety-grid">
            <article className="lp-card lp-safety">
              <Lock size={19} aria-hidden />
              <h3>Key 只在当前会话</h3>
              <p className="lp-muted">使用你自己的火山方舟 Key，仅保存在当前标签页会话中，关闭即清除；不写入磁盘、Cookie、日志或导出文件。</p>
            </article>
            <article className="lp-card lp-safety">
              <HardDrive size={19} aria-hidden />
              <h3>项目数据本机存储</h3>
              <p className="lp-muted">项目、画布草稿、版本、素材与运行记录保存在本机浏览器，没有云数据库、账号体系与上传统计。</p>
            </article>
            <article className="lp-card lp-safety">
              <ShieldCheck size={19} aria-hidden />
              <h3>受控代理与输出校验</h3>
              <p className="lp-muted">请求经本地同源代理转发并限定官方域名；图片中的文字与指令只作为分析内容，模型输出先过结构校验，不能决定网址或系统命令。</p>
            </article>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="lp-section lp-section-tint" id="faq">
        <div className="lp-container lp-faq-wrap">
          <h2 className="lp-h2">常见问题</h2>
          <div className="lp-faq">
            {FAQS.map((f) => (
              <details className="lp-faq-item" key={f.q}>
                <summary>{f.q}</summary>
                <p className="lp-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* 底部 CTA */}
      <section className="lp-final">
        <div className="lp-container lp-final-inner">
          <h2>从一个项目开始，先跑通一件商品</h2>
          <p>无需先配置模型也可以搭建和保存工作流；准备好 Key 后即可试运行与批量出图。</p>
          <button type="button" className="btn primary lp-cta-lg" onClick={enterWorkbench}>
            进入工作台
            <ArrowRight size={16} />
          </button>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-container lp-footer-inner">
          <div>
            <strong>Visual Director · 视觉配方工厂</strong>
            <p className="lp-muted">本地优先的静物电商视觉生产工作台 · v0.1.0</p>
          </div>
          <p className="lp-muted lp-footer-note">
            本产品不内置模型额度，生成结果需人工核验后使用；页面展示的验收权重与状态规则为产品判定规则，非行业标准。
          </p>
        </div>
      </footer>
    </div>
  );
}

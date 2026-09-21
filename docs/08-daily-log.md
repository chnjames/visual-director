# 每日开发记录

## 2026-09-16

- 初始方向为Visual Director｜商品视觉导演，经过五轮产品压力测试后升级为Visual Recipe｜视觉配方工厂。
- 核心产品从“生成一套营销图”收束为“参考图转可验证工作流，并批量用于静物商品场景图”。
- 明确不复刻SellerPic全功能，只吸收参考图分析、画布和批量生产思路。
- 确定公开站不提供免费模型额度。
- 确定预置案例、用户自带密钥、自部署三种模式。
- 选定豆包工作作为主要开发工具。
- 曾创建React + TypeScript + Vite脚手架，随后按作者要求全部移出项目，不作为参赛工程代码。
- 当前项目只保留需求与验收文档；项目初始化和全部代码必须由规定模型在豆包工作中生成。
- 已确定半开放画布、12字段视觉配方、商品身份锁定、双重验收、单次自动修复和商品级失败隔离。
- 已确定首轮只开发模型探针台，不直接开发完整产品。
- 下一步：在豆包工作中打开此目录，让规定模型阅读最新版文档后初始化工程并完成三项探针。

---

## 2026-09-16 · 阶段1「模型探针台」工程实现记录（豆包工作执行）

### 实际技术选型

- 前端：React 18 + TypeScript 5.6 + Vite 5.4（`@vitejs/plugin-react`）。
- Schema：Zod 3.23，直接对应 `docs/03` 产品合同，负责缺字段/错类型/枚举/范围/12 字段完整性校验。
- 测试：Vitest 2.1 + @testing-library/react + jsdom（globals 模式）。
- 模型代理：Node 原生 `fetch`/`http`，不引入 Express 等框架；同构处理器 `src/server/arkProxy.ts`
  在 Vite 开发中间件、零依赖独立服务器与单元测试中复用。
- 运行环境实测：Node v22.23.2、npm 10.9.8、Git 2.45.1（Windows）。
- 选型理由：TS 类型即合同；Zod 强约束模型输出；同构 fetch 代理可单测；data-URI 多模态消息支持图片输入；轻量、便于阶段2/3 扩展。

### 初始化 / 验证命令（均真实执行）

- `npm install`（新增依赖，含 react/react-dom/zod；dev：vite/vitest/ts/testing-library/jsdom/@types/node）。
- `npx tsc --noEmit`：类型检查。
- `npx vitest run`：自动化测试。
- `npm run build`（= `tsc --noEmit && vite build`）：生产构建。
- `node server/proxy-server.mjs` 与 `npm run dev` 后分别跑 `node scripts/smoke-proxy.mjs http://localhost:5173`：HTTP 冒烟。
- 内置浏览器真实打开 `http://localhost:5173`：无 Key 首页、模型设置弹窗、URL 形态 Endpoint 拦截、只读样例等待态。
- `git init -b main` + 首次提交（commit `d9a77ee`）；`.gitignore` 排除 node_modules/dist/.env/日志。

### 创建的文件（工程文件 43 个，docs 原样保留）

- 工程配置：`package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`vitest.setup.ts`、`index.html`、`.gitignore`、`.env.example`、`README.md`。
- `src/shared/`：`constants.ts`（12 字段、数量边界、固定 Base URL、40/30/20/10 权重、Endpoint 白名单）、`types.ts`、`schema.ts`（Zod + 装配 + 验收状态确定性计算）、`security.ts`（Key 会话存储/脱敏/错误分类/Endpoint 校验）。
- `src/model/`：`prompts.ts`（三探针 Prompt，含提示注入防御、不恢复原 Prompt）、`images.ts`、`parseJson.ts`、`arkClient.ts`。
- `src/server/`：`arkProxy.ts`（固定主机、字段白名单、超时、脱敏错误）、`arkDevProxy.ts`（Vite 中间件）。
- `src/components/`：三探针面板、`ModelSettingsModal.tsx`、`ImageUploader.tsx`、证据/诊断/原始输出/通用门组件，共 10 个；外加 `src/hooks/useModelSettings.ts`、`src/samples/manifest.ts`（当前为空，等待真实运行）、`src/App.tsx`、`src/main.tsx`、`src/styles.css`。
- 自部署与冒烟：`server/proxy-server.mjs`、`scripts/smoke-proxy.mjs`。
- 测试 7 个文件：schema / audit / security / parseJson / arkProxy / arkClient / App。

### 遇到的第一次失败与修复

- 第一次失败：`npx vitest run` 时 `App.test.tsx` 用 `getByText(/等待真实运行/)` 断言只读样例页，
  但该文案在“策略说明条”和“等待标题”中出现两次，Testing Library 报 found multiple elements，1 项失败（52/53 通过）。
- 修复：这是测试断言问题（产品行为本身正确，两处都应提示等待），改为 `getAllByText(...).length >= 1`；重跑 53/53 通过。
- 类型检查阶段另修复若干 TS 严格模式问题：vi.fn 缺少泛型导致 mock.calls 元组为 `[]`、`arkClient` 未使用变量、`AuditIssue` 类型未导入；均已修正并复验通过。

### 真实测试与构建结果（无虚构）

- 类型检查 `npx tsc --noEmit`：通过（exit 0）。
- 自动化测试 `npx vitest run`：7 个测试文件、**53/53 通过**。
  覆盖：VisualRecipe 合法/缺字段/重复/错类型/越界；IdentityFeature 强制 pending 与人工确认；
  验收 passed/warning/failed、严重错误一票否决、needs-review、权重与边界；Key 不入 localStorage/cookie、脱敏、
  Endpoint 白名单；代理固定主机、忽略任意 baseUrl、401/超时/网络/非法 JSON/诊断不含 Key；
  客户端未配置/非法 Endpoint/Key 只在请求头/非法 JSON/Schema 违规/超时网络；无 Key 页面渲染与设置保存。
- 生产构建：成功，60 模块，产物 `dist/index.html` 0.41kB、CSS 7.72kB、JS 230.17kB（gzip 73.57kB）。
- HTTP 冒烟（独立服务器与 Vite 开发服务器各一次，均 SMOKE OK）：首页 200；无 Key→400 not-configured；
  URL Endpoint→400 illegal-endpoint 且不回显 Key；用假 Key 向**固定官方地址**真实转发得到 401
  （Vite 路径归类 invalid-key），响应不回显 Key。
- 真实浏览器：无 Key 等待态渲染正常；设置弹窗 Base URL 置灰固定；填入 `https://evil.example.com/v1`
  被实时拦截且无法保存；只读样例页显示“等待真实运行 / 不提供伪造样例”。

### 尚未验证（如实标注，数字一律“待测”）

- 未使用真实有效 API Key / 接入点跑通 Seed 多模态调用，故：连续 3 次合法 12 字段配方、
  身份候选质量、5 张错误图识别率、字段准确率、Token、耗时等**全部待测**，本阶段不给出任何此类数字。
- 未做真实图片端到端生成（本阶段本就不做生成）。
- `server/proxy-server.mjs` 为最小自部署托管，错误分类权威实现以被单测覆盖的 `src/server/arkProxy.ts` 为准，
  后续可让独立服务器复用同一打包产物，消除少量重复。
- 阶段0 的真实静物样本与人工金标准尚未提供。

### 下一阶段启动条件判断

- 工程侧（Key 安全检查、类型检查、测试、构建、无 Key 可用性、非法输出不崩溃）已具备阶段2 工程基础。
- 但按 `docs/10` 阶段1 验收，尚缺**真实模型探针结果**（同组参考图连续 3 次过 Schema、5 张错误图≥4 张识别正确）。
  结论：**工程脚手架就绪，但阶段1 验收需在作者提供真实 Key/Endpoint 与样本后跑完探针才能闭环；在此之前不进入阶段2 画布开发。**

---

## 2026-09-16 · 变更记录：Base URL 可修改 + OpenAI/Anthropic 双协议

### 变更背景与决策

- 作者指出“Base URL 固定不可改”有问题，要求：
  - Base URL 可在“模型设置”中修改；
  - 提供两个默认地址（逐字采用作者给定值）：
    - 兼容 OpenAI 接口协议：`https://ark.cn-beijing.volces.com/api/plan/v3`
    - 兼容 Anthropic 接口协议：`https://ark.cn-beijing.volces.com/api/plan`
- 安全取舍：地址放开为可改，但**主机名仍硬限定为火山官方域名 `.volces.com` 且必须 https**
  （拒绝用户名/密码、查询串、hash、http、任意外部主机），以保留 `docs/09` 的 SSRF 停止线；
  若将来需要接自有网关，再显式放开白名单（当前未放开，已作为待决项保留）。
- 协议差异在**代理侧归一化**：浏览器内部始终用 OpenAI 风格 messages。
  - OpenAI：`{base}/chat/completions`，`Authorization: Bearer`；
  - Anthropic：`{base}/v1/messages`，`x-api-key` + `anthropic-version: 2023-06-01`，
    代理抽取 system 消息、把 content 转为 text/image(base64 data URI) 块、补 `max_tokens`，
    并把 Anthropic 的 `content[].text`、`input_tokens/output_tokens`、`request_id`
    归一为统一响应 `{ok,content,usage,requestId,diagnostics}`；
  - Anthropic 图片仅接受 data: base64，外部图片 URL 一律丢弃（不触发服务端抓取，防 SSRF/数据外泄）。

### 改动文件

- `src/shared/constants.ts`：删除旧固定常量；新增 `ArkProtocol`、`ARK_DEFAULT_BASE_URLS`、
  `ARK_API_PATHS`、`ANTHROPIC_VERSION`、`ARK_ALLOWED_HOST_SUFFIXES`、`buildArkUpstreamUrl()`。
- `src/shared/types.ts`：`ModelSettings` 增加 `protocol`、`baseUrl`；`SafeDiagnostics` 增加
  可选 `protocol`、`targetUrlMasked`。
- `src/shared/security.ts`：设置读写带默认值并兼容旧存储（缺字段补 OpenAI 默认）；
  新增 `isValidBaseUrl()`（https + 官方主机后缀白名单 + 拒绝凭据/query/hash）；诊断透传协议/目标地址。
- `src/server/arkProxy.ts`：重写为双协议，含 Anthropic 请求体/鉴权/响应归一化、Base URL 白名单校验。
- `src/model/arkClient.ts`：请求体携带 `protocol/baseUrl`，客户端侧增加 Base URL 校验。
- `src/components/ModelSettingsModal.tsx`：新增协议单选、可编辑 Base URL、最终地址实时预览、
  恶主机行内拦截、“恢复该协议默认值”，切换协议自动重置对应默认 Base URL。
- `src/components/DiagnosticsView.tsx`、`src/App.tsx`：展示协议与目标地址、顶部状态显示协议。
- `server/proxy-server.mjs`：零依赖独立服务器同步支持双协议与主机白名单、响应归一化。
- 测试：`security.test.ts`（+Base URL/旧设置迁移用例，共 14）、`arkProxy.test.ts`（重写，
  含 Anthropic 转换、外部图片 URL 丢弃、恶主机拦截，共 11）、`arkClient.test.ts`（补新字段）、
  `App.test.tsx`（+恶主机拦截与协议切换用例，共 5）。
- `scripts/smoke-proxy.mjs`：请求体补 protocol/baseUrl，新增 Anthropic 转发与恶主机用例。
- `.env.example`、`README.md`：说明从“固定 Base URL”改为“可修改 + 双协议 + 主机白名单”。

### 遇到的第一次失败与修复（本次变更）

- 失败 1：改造后首次 `npx tsc --noEmit` 报错——`security.test.ts` 里的 `SETTINGS` 字面量
  缺少新增必填字段 `protocol/baseUrl`（TS2345）。修复：补齐字段后类型检查通过。
- 失败 2：`vitest` 中新增 App 用例 `getByText(/仅允许火山方舟官方/)` 命中行内提示与表单错误两处；
  改为 `getAllByText(...).length > 0`。
- 失败 3：协议单选 `getByRole('radio',{name:/Anthropic/})` 因嵌套 `<label>` 导致两个 radio
  可访问名称重复；改为给 radio 加 `data-testid="protocol-openai|anthropic"` 后稳定通过。

### 真实测试与构建结果（无虚构，均本次重跑）

- `npx tsc --noEmit`：通过（exit 0）。
- `npx vitest run`：**7 个测试文件、58/58 全部通过**（较改造前 53 增加 5 个用例）。
- `npm run build`：成功，60 模块；`dist/index.html` 0.41kB、CSS 7.72kB、JS 232.93kB（gzip 74.44kB）。
- HTTP 冒烟（Vite 5173 与独立服务器 5180 各一次，均 SMOKE OK，9 项检查）：
  首页 200；无 Key→400 not-configured；URL Endpoint→400；恶主机 Base URL→400 illegal-endpoint；
  OpenAI 与 Anthropic 两种协议用假 Key **真实转发到官方域名**均得 401 invalid-key，且响应不回显 Key。
- 内置浏览器复测：设置弹窗显示协议单选与可编辑 Base URL；填入 `https://evil.example.com/v1`
  实时提示“仅允许官方域名”、最终地址显示“不合法”；切到 Anthropic 自动变为
  `https://ark.cn-beijing.volces.com/api/plan`、预览 `.../api/plan/v1/messages`；
  切回 OpenAI 恢复 `/api/plan/v3`、预览 `.../chat/completions`。

### 尚未验证 / 待决

- 真实有效 Key/接入点下的端到端探针、准确率、Token、耗时仍**全部待测**（同前，需作者提供）。
- 待决：是否把主机白名单放开到任意 https（接自有网关场景）；当前按 SSRF 停止线限定 `.volces.com`。

---

## 2026-09-16 · 缺陷修复：视觉配方探针“一直请求超时”

### 现象与根因

- 作者反馈：模型设置“测试连接”通过，但运行视觉配方探针一直请求超时。
- 根因（两处叠加）：
  1. **图片原图直传、无压缩**：`readImageFile` 仅把本地文件转 data URI，手机/相机原图单张常达数 MB，
     1-5 张 base64（再膨胀约 1/3）后请求体可达数十 MB；仅上传就可能耗尽代理 60s 超时。
     “测试连接”只发 1 token 文本、不带图，因此秒过——与现象完全吻合。
  2. **超时一刀切**：探针（多图 + 长 JSON 输出）与测试连接共用 60s，对视觉生成偏短。

### 修复

- `src/model/images.ts`：上传前在浏览器端等比缩放/压缩——最长边 >1568px 或原图 >约1.5MB 时，
  白底转 JPEG，逐级降质（0.85/0.72/0.6）把单图请求体积压到约 2.5MB 内；小图与无 canvas 环境保持原样；
  压缩失败回退原图不阻断。`UploadedImage` 增加 `bytes/width/height`，上传组件显示“尺寸 · 体积（已压缩）”。
- 分级超时（`constants.ts` 新增 `ARK_TEST_TIMEOUT_MS=30s`、`ARK_PROBE_TIMEOUT_MS=180s`、
  默认 120s、上下限 5s–180s 与 `clampTimeoutMs()`）：探针 180s、测试连接 30s；客户端比服务端多 15s 缓冲，
  保证先收到服务端规范 504。代理（`arkProxy.ts`）与独立服务器（`proxy-server.mjs`）均读取并钳制
  客户端下发的 `timeoutMs`，且该字段不会转发给上游。

### 真实验证（无虚构）

- `npx tsc --noEmit`：通过；`npx vitest run`：**7 文件 59/59 通过**（新增超时钳制用例）。
- `npm run build`：成功，60 模块，JS 234.77kB（gzip 75.15kB）。
- HTTP 冒烟（Vite 5173，SMOKE OK，9 项）：无 Key/非法 Endpoint/恶主机拦截、OpenAI 与 Anthropic
  假 Key 真实转发得 401 且不回显 Key，均通过。
- 真实浏览器压缩验证：生成 4000×3000、**7.22MB** JPEG 上传，界面显示被压到
  **1568×1176 · 627KB（已压缩）**，体积约降 91%（验证后已移除测试图，未发起真实模型调用、未消耗额度）。
- 说明：真实探针端到端是否在 180s 内稳定返回，仍需作者用有效 Key/接入点复测确认（本轮不代跑、不虚构耗时）。


---

## 2026-09-16 · 缺陷修复：视觉配方探针“一直请求超时”

### 现象与根因

- 作者反馈：模型设置“测试连接”通过，但运行视觉配方探针一直请求超时。
- 根因（两处叠加）：
  1. **图片原图直传、无压缩**：`readImageFile` 仅把本地文件转 data URI，手机/相机原图单张常达数 MB，
     1-5 张 base64（再膨胀约 1/3）后请求体可达数十 MB；仅上传就可能耗尽代理 60s 超时。
     “测试连接”只发 1 token 文本、不带图，因此秒过——与现象完全吻合。
  2. **超时一刀切**：探针（多图 + 长 JSON 输出）与测试连接共用 60s，对视觉生成偏短。

### 修复

- `src/model/images.ts`：上传前在浏览器端等比缩放/压缩——最长边 >1568px 或原图 >约1.5MB 时，
  白底转 JPEG，逐级降质（0.85/0.72/0.6）把单图请求体积压到约 2.5MB 内；小图与无 canvas 环境保持原样；
  压缩失败回退原图不阻断。`UploadedImage` 增加 `bytes/width/height`，上传组件显示“尺寸 · 体积（已压缩）”。
- 分级超时（`constants.ts` 新增 `ARK_TEST_TIMEOUT_MS=30s`、`ARK_PROBE_TIMEOUT_MS=180s`、
  默认 120s、上下限 5s–180s 与 `clampTimeoutMs()`）：探针 180s、测试连接 30s；客户端比服务端多 15s 缓冲，
  保证先收到服务端规范 504。代理（`arkProxy.ts`）与独立服务器（`proxy-server.mjs`）均读取并钳制
  客户端下发的 `timeoutMs`，且该字段不会转发给上游。

### 真实验证（无虚构）

- `npx tsc --noEmit`：通过；`npx vitest run`：**7 文件 59/59 通过**（新增超时钳制用例）。
- `npm run build`：成功，60 模块，JS 234.77kB（gzip 75.15kB）。
- HTTP 冒烟（Vite 5173，SMOKE OK，9 项）：无 Key/非法 Endpoint/恶主机拦截、OpenAI 与 Anthropic
  假 Key 真实转发得 401 且不回显 Key，均通过。
- 真实浏览器压缩验证：生成 4000×3000、**7.22MB** JPEG 上传，界面显示被压到
  **1568×1176 · 627KB（已压缩）**，体积约降 91%（验证后已移除测试图，未发起真实模型调用、未消耗额度）。
- 说明：真实探针端到端是否在 180s 内稳定返回，仍需作者用有效 Key/接入点复测确认（本轮不代跑、不虚构耗时）。




---

## 2026-09-16 · 阶段2「单件工作流」工程落地

### 范围界定（与 docs/01、docs/02、docs/10 对齐）

- 本阶段只做**固定线性 7 节点单件流程**：参考图输入 → 商品输入 → 配方提取 → 身份锁定 →
  场景生成 → 结果验收 →（失败时）定向修复一次。**不是**可拖拽自由画布（那是阶段3）。
- 两道人工闸门：①确认视觉配方（含商品无关迁移边界）后才能生成；②高风险修复（形态/Logo/
  材质/虚构文字/部件类 critical）默认暂停，必须人工确认才重生成。
- 每件商品最多定向修复 1 次；修复→重生成以“版本化尝试 v1/v2”实现，固定主干图中**不引入环**。
- 调用预算运行前展示：预计 4（配方/身份/生成/验收各 1），最坏 7（再叠加修复 1 + 重生成 1 + 重验收 1）。

### 实际技术选型（沿用阶段1，未引入重型依赖）

- 继续 React18 + TypeScript + Vite + Zod + Vitest；不引入状态机/画布/状态管理库，
  状态机与工作流定义均为自研纯函数，便于单测与阶段3复用。
- 图片生成只走 **OpenAI 兼容** `{openaiBase}/images/generations`、Bearer、强制 `response_format=b64_json`；
  Anthropic 协议设置下自动改用 OpenAI 兼容基址（Anthropic 无图片接口）。
- 新增设置项 `imageEndpoint`（图片生成接入点/模型 ID，与视觉理解 Endpoint 分开；可留空，仅探针仍可用）。
- 本地持久化用**自研极简 IndexedDB 封装**（无第三方库），无 IDB 环境退化为内存；
  API Key 仍只在 sessionStorage，绝不进入 IndexedDB / 项目 JSON。

### 新增/修改文件

- 新增：`src/workflow/` 下 `workflowConstants / workflowTypes / workflowSchema / fixedWorkflow /
  promptCompiler / stateMachine / orchestrator` 及对应测试；`src/server/arkImageProxy.ts`(+测试)；
  `src/data/db.ts`；`src/hooks/useSingleItemWorkflow.ts`；`src/components/workflow/WorkflowPanel.tsx`(+测试)；
  `src/model/arkImageClient.test.ts`。
- 修改：`shared/constants.ts`（图片路由/路径/超时/OpenAI 基址解析）、`shared/types.ts`
  （`ModelSettings.imageEndpoint`、`ProbeKind` 增加 repair）、`shared/security.ts`（imageEndpoint 默认值/裁剪）、
  `model/arkClient.ts`（`generateImage`）、`model/prompts.ts`（`buildRepairMessages`）、
  `components/ModelSettingsModal.tsx`（图片 Endpoint 输入）、`server/arkDevProxy.ts` 与
  `server/proxy-server.mjs`（挂载 `/api/ark/images`）、`App.tsx`（新增“单件工作流”Tab 并设为默认）、
  `styles.css`、`scripts/smoke-proxy.mjs`（图片路由 5 项）。

### 关键安全/合同约束的落地

- Prompt 编译器单向、确定性：唯一事实来源是**已确认** VisualRecipe + **confirmed** 身份特征；
  pending/rejected 特征不进硬约束；最终 Prompt 界面只读，自由文本不能反向覆盖已确认结构。
- 修复是否“高风险”由**代码**依据验收问题（identity 维度 critical，或描述涉及 Logo/材质/形态/变形/部件/文字）
  计算，模型自报的 highRisk 字段被 Zod 丢弃。
- 图片代理：主机仍限 `.volces.com` 且 https；仅白名单字段（model/prompt/n/response_format/合法 size）；
  只接受 `data[].b64_json`，**不跟随外部图片 URL**（防 SSRF）；Key 仅 Bearer 头，错误/日志不回显 Key。
- 状态机：进行中（analyzing/generating/auditing/repairing/queued）刷新一律转 interrupted，
  由用户显式“回到草稿”，不伪装运行；warning/needs-review 只能人工接受为 passed；failed 才能修复且仅一次。

### 第一次失败与修复

- 首次 `npx tsc --noEmit` 报多处类型错误：阶段1 的 `confirmFeature(feature)`/`rejectFeature(feature)`
  是“单特征”签名、`assembleAuditResult(productId, raw)` 参数顺序与我初版假设相反，导致 hook 与测试误用。
- 修复：按现有 schema.ts 真实签名改为 `features.map(f=>confirmFeature(f))` 与
  `assembleAuditResult(candidate.id, raw)`，并修正测试同类误用；随后 tsc 通过。
- 测试首次运行 108/109：默认 Tab 改为工作流后页面出现两个“选择图片”按钮，旧断言
  `getByRole('选择图片')` 命中多个元素；改为先点击“A 视觉配方”Tab 再断言，转绿。

### 真实测试与构建结果（无虚构）

- `npx tsc --noEmit`：通过（exit 0）。
- `npx vitest run`：**15 个测试文件、111/111 通过**（阶段1 基线 59，阶段2 净增 52）。
  新增覆盖：编译器（未确认/缺字段拒绝、仅 confirmed 入硬约束、12 字段顺序、负向合并去重、空身份兜底）；
  状态机（主路径、修复一次、二次修复拒绝、非法转移、warning/needs-review 人工接受、刷新中断）；
  修复 Schema（highRisk 代码裁决、模型自报被忽略、持久化形状校验）；固定主干（7 节点、永久/可跳过、
  on-fail 条件边、无环、篡改拒绝）；编排器（happy path 4 调用、失败→高风险修复→重生成共 7 调用且不能再修、
  needs-review 人工接受、生成失败、未配置不崩溃、刷新中断、数量边界）；图片代理（无 Key/非法 Endpoint/
  恶主机/Anthropic 自动换 OpenAI 基址/只收 b64/401/超时/不回显 Key）；图片客户端（未配置/缺图片 Endpoint/
  URL Endpoint/成功路径 Key 只在头/业务错误透传）。
- `npm run build`：成功，**68 模块**，CSS 8.81kB（gzip 2.51）、JS 264.86kB（gzip 84.63）。
- HTTP 冒烟：Vite 5173 与生产独立服务器（PORT=5180，构建后）各一次，均 **SMOKE OK（14 项）**，
  图片路由无 Key/非法 Endpoint/恶主机拦截、Anthropic 设置下真实转发到官方 OpenAI 图片地址得 401、不回显 Key。
- 真实浏览器（内置浏览器，localhost:5173）：默认进入“单件工作流”Tab；参考图(1-5)/商品图(2-3)上传位、
  用途输入、调用预算 4/7、数量不足时“创建并开始分析”禁用均正常；模型设置弹窗出现“图片生成 Endpoint”
  字段与“固定走 /images/generations、Anthropic 自动用 OpenAI 基址”说明；页面无任何伪造结果。

### 尚未验证 / 记录在案的例外（不虚报）

- **未用真实模型端到端跑通过一件商品**：作者当前会话未提供有效的图片生成 Endpoint（如 Seedream），
  本轮没有、也不应伪造生成图/准确率/Token/耗时。生成→验收→修复完整链路已用可注入 runner 的单测覆盖逻辑，
  真实出图与修复效果需作者配置有效 `imageEndpoint` 后复测。
- 阶段1 遗留的真实模型验收闸门（连续 3 次过 Schema、5 张错误图识别 ≥4）仍待作者用真实 Key 闭环。
- 图片生成请求体刻意保持最小（不发兼容性不确定的 negative_prompt，负向约束折叠进 prompt 文本；
  默认不发 size 用模型默认），真实接入点若要求特定 size/参数，需复测后按白名单方式增补。
- IndexedDB 进行中→interrupted 的自动判定由单测覆盖，未在浏览器人为制造崩溃逐一真机复测。

### 下一阶段启动条件评估

- 工程侧已具备：固定主干定义、状态机、编译器、版本化生成/验收/修复、图片安全通道与本地持久化，
  且全部单测/构建/冒烟通过。阶段3（批量队列与**可拖拽**画布编辑器）可复用 WorkflowDefinition 与状态机。
- 但建议进入阶段3前，先用真实 Key + 有效视觉/图片接入点闭环“一件商品真实出图 + 验收 + 必要时一次修复”，
  据此校准验收阈值/权重与图片接口参数，再放大到批量，避免把未校准的单条链路复制成批量风险。


---

## 2026-09-17 · 阶段3：工作流画布与批量运行（docs/10 阶段3 五条）

### 实际技术选型（沿用阶段1/2，不引入重型依赖）

- 继续 React 18 + TypeScript + Vite + Zod + Vitest（jsdom）+ Testing Library，无新增运行时依赖。
- 新增独立 `src/batch/` 领域模块，**复用阶段2 的 `WorkflowDefinition`、固定主干、状态机 `transition`、
  `compilePrompt`、`defaultRunners`、Schema 装配与 `createWorkflow`，不改动阶段2 已验证逻辑**。
- 画布按 docs/09 的降级口径实现为**固定主干实时可视化**（7 节点坐标固定、不可自由拖拽/连线/自定义代码），
  仅 `identityLock`、`resultAuditor` 两个可跳过节点提供开跑前开关；画布与批量页共享同一个
  `WorkflowDefinition`（`batch.definition`）与同一个 React 控制器实例。
- 并发用两个计数信号量：同时分析（身份/修复）2 件、同时生成 1 件；每件一个 async worker，
  用 park/gate 实现整批/单件暂停与身份、修复、接受三道人工闸门。
- 错误分级：`invalid-key/quota/endpoint-not-found/server/not-configured` 为系统级→整批 `system-paused`、
  在途该件判 `interrupted`、唤醒其余件；其余为商品级，仅该件失败；network/timeout 连续 3 次升级系统级。
- 持久化：IndexedDB 升级到 **DB v2**，新增 `batch` store（key `current-batch`）；加载即把在途状态判为
  `interrupted`（`parsePersistedBatch` 内做 Schema 校验 + 中断降级），刷新后绝不伪装仍在运行；Key 不入库。

### 本轮新建文件

- `src/batch/batchConstants.ts`（批量固定规则：≤5 件、每件 2-3 图、并发 2/1、连续网络阈值 3、队列/等待态常量）
- `src/batch/batchTypes.ts`（Batch / BatchItem / BatchBudget / 行统计等类型）
- `src/batch/batchBudget.ts`（错误分级、网络判定、按件身份/验收开关、预计/最坏调用预算、状态→节点映射、终态）
- `src/batch/batchFactory.ts`（建批、配方闸门、分组增删改/命名/身份模式、仅两节点可跳过、分组与预算确认）
- `src/batch/batchQueue.ts`（最新尝试/验收、等待态重算、行展示态、进度统计、刷新中断降级、状态文案）
- `src/batch/batchEngine.ts`（BatchEngine：信号量并发、worker、暂停/恢复/跳过/重试、身份/修复/接受闸门、
  错误分级与系统暂停、调用计数与结算）
- `src/batch/batchSchema.ts`（持久化 Zod 形状、版本校验、解析即中断降级）
- `src/batch/batchTestUtils.ts`（测试夹具与可控假 runners/Deferred，不发起真实调用）
- 测试：`batchBudget.test.ts`、`batchFactory.test.ts`、`batchQueue.test.ts`、`batchEngine.test.ts`
- `src/hooks/useBatchController.ts`（批量 React 控制器：加载即中断、IDB 持久化、引擎按需创建）
- `src/components/batch/WorkflowCanvas.tsx`（固定主干 SVG 画布 + 两节点跳过开关）
- `src/components/batch/BatchPanel.tsx`（准备/分组/预算三步、运行表格、逐件抽屉与全部操作）
- `src/components/batch/batchUI.test.tsx`（画布与批量页组件测试）

### 本轮修改文件

- `src/data/db.ts`：DB_VERSION 1→2，新增 `batch` store 与 save/load/clear，事务按 store 名打开，Key 仍不入库。
- `src/App.tsx`：新增“工作流画布”“批量运行”两个 Tab，顶层实例化一次 `useBatchController` 供两页共享。
- `src/styles.css`：追加画布与批量样式。
- `docs/08-daily-log.md`、`README.md`：阶段3 记录与说明。

### 初始化 / 测试 / 构建命令（均真实执行）

- `npx tsc --noEmit`：通过（0 error）。
- `npx vitest run`：**20 个测试文件、162 个用例全部通过**（阶段2 为 15 文件 111 用例，本轮净增 51 个）。
  新增覆盖：预算（按件身份/验收/跳过、修复链 worst=expected、跳过件不计费、数量边界、节点映射）；
  工厂（配方闸门、≤5 件、2-3 张、重名、仅两节点可跳过、预算确认）；队列（进度统计、等待态、
  刷新在途→interrupted、损坏/版本不符拒绝加载、settled 判定）；引擎（3 件跳过身份全自动且调用数=预计、
  身份并发=2/生成串行=1/身份闸门逐件确认、商品级失败隔离、invalid-key 整批暂停+该件中断+处置后恢复、
  连续 3 次网络升级、低风险自动修复一次共 5 调用且=最坏值、高风险停车 applyRepair 后才重生成、
  warning 人工接受、暂停后不发起新调用、生成失败手动重试 retryCount+1、跳过验收→needs-review 不调验收、
  未配置不能 start）；UI（未配置只读、预算明示、开始、运行/暂停/系统暂停横幅、画布 7 节点与仅 2 个跳过开关）。
- `npm run build`：成功，**78 模块**，CSS 12.81kB（gzip 3.49）、JS 308.95kB（gzip 97.68）。
- `node scripts/smoke-proxy.mjs`：**SMOKE OK（14 项）**，安全代理无回归（无 Key/URL 形态 Endpoint/
  恶主机 SSRF/401 分类/不回显 Key 等）。
- 真实浏览器（内置浏览器 localhost:5173）：新增“工作流画布/批量运行”Tab 正常；画布无批次时显示空态；
  批量页第一步显示参考图上传、用途输入，无参考图时“提取视觉配方”禁用；未配置/无结果时无伪造结果；控制台 0 报错。

### 遇到的失败与修复（第一次失败起如实记录）

1. 首次 `vitest run` 即暴露**预算逻辑 bug**：`itemUsesIdentity` 只看画布是否跳过身份节点，未看每件
   `identityMode`，导致选择“跳过身份”的件仍被计入 1 次身份调用（预计 6 被算成 9）。改为
   `itemUsesIdentity(batch, item)` 同时判断节点未跳过且该件为 lock，预算改为按件计算。
2. 系统级暂停恢复用例超时，定位到两个引擎缺陷：
   - 排队等待信号量的件在“取到信号量”时批次可能已暂停，原代码取到即发起调用，违反“暂停不发起新调用”；
     新增 `acquireWithPause`：取到信号量后若已暂停则释放并挂起，恢复后重新排队。
   - 中断件 `resumeItem` 只把状态改回 draft，失败的半成品 attempt（无图片）仍在，引擎误判“已生成”空转退出；
     改为与手动重试一致地重建干净工作流（保留共享配方、已确认身份与已用计数，但不计 retryCount）。
3. 组件测试发现**真实 UI 缺陷**：确认预算后状态变 `ready`，而准备面板只认 `setup`，导致“确认成本并开始
   批量”按钮随面板一起消失。修正为 `setup/ready` 都属于开跑前准备态。
4. 若干 TS noUnusedLocals/类型收窄问题（未用导入、FAIL 转移状态收窄、测试夹具类型）逐一修复。

### 尚未验证 / 记录在案的例外（不虚报）

- **仍未用真实模型端到端跑通**：本会话没有有效的图片生成 Endpoint / 真实出图，批量真实并发耗时、Token、
  真实出图质量、真实修复效果、真实 Key 下的系统暂停恢复均未实测；相关行为全部由可注入 runner 的单测与
  组件测试覆盖逻辑，需作者配置有效接入点后复测。阶段1 真实模型闸门、阶段2 单件真实出图同样仍待复测。
- 刷新→interrupted 的自动判定由单测与持久化往返测试覆盖，未在浏览器里人为制造崩溃逐台真机复测。
- 画布按 docs/09 采用固定主干可视化（非自由拖拽编辑器）；docs/01 本就禁止任意连线/循环/悬空边/自定义代码。

### 下一阶段启动条件评估

- 阶段3 五条验收（画布与批量共用 WorkflowDefinition；5 件分组/排队/暂停/恢复/隔离失败；刷新不伪装运行；
  开始前明示预计/最坏调用数；单件失败不影响其余）在代码、单测/组件测试、构建、代理冒烟与静态浏览器检查层面
  均已满足。
- 建议进入下一阶段前，先以真实 Key + 有效视觉/图片接入点完成“单件真实出图→验收→（必要时）一次修复”，
  再跑一次真实 2-5 件批量，校准并发下的限流/超时与恢复体验，避免把未校准链路继续放大。

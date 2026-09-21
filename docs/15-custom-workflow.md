# 15 · 自定义可执行工作流（Custom Executable Workflows）

状态：本文件是工作流图、节点注册与执行适配的**唯一权威规格**。
它取代此前 docs/11、docs/12 中“节点固定、连接只读、不可增删节点”的约束。
适用版本：自定义工作流阶段起。安全红线（§11）不随本规格放宽。

---

## 1. 设计目标与非目标

### 1.1 目标
- 用户可在画布上**添加、删除、复制、连接**节点，编辑草稿，发布为**不可变版本**。
- 工作流图不是演示动画：发布版本可被单件试运行与批量任务**真实执行**。
- 执行仍然走现有的模型调用单元（runners）、Schema 装配、状态机与安全代理；图只决定**调用顺序、数据绑定与人审暂停点**。
- 内置“静物标准工作流”作为出厂模板，等价于今天的固定主干，旧项目零成本继续。

### 1.2 非目标（明确不做）
- 不提供自定义代码 / Shell / 脚本 / 表达式求值节点。
- 不提供任意 HTTP 请求节点、Webhook 触发节点、文件系统节点。
- 不允许循环（DAG only）、不允许子图嵌套（首版）。
- 不允许用户上传或安装节点包 / 插件。
- 不允许模型输出决定 URL、文件路径或要调用的节点类型。
- 不做并行分叉/汇聚执行（首版图是线性或单分支 DAG；见 §9 限制）。

---

## 2. 三层概念

```
节点定义 NodeDefinition   （内置注册表，描述“能做什么”，不可由用户新增）
   ↓ 实例化
节点实例 NodeInstance      （图上的一个块：位置、配置、端口接线）
   ↓ 组织成
工作流图 WorkflowGraph      （节点 + 有类型边）
   ↓ 编辑
工作流草稿 WorkflowDraft    （可反复改、可存、不保证可执行）
   ↓ 校验通过后发布
工作流版本 WorkflowVersion  （不可变、内容寻址、可被运行引用）
   ↓ 规划
执行计划 ExecutionPlan      （拓扑序的步骤 + 数据绑定 + 闸门）
   ↓ 驱动
GraphExecutor              （按计划调用既有 runners，不实现模型逻辑）
```

---

## 3. 数据模型

所有标识：`n_`（节点实例）、`p_`（端口）、`e_`（边）、`wf_`（草稿/版本）。

### 3.1 类型化数据端口

端口携带**逻辑数据类型**，用于连接兼容校验。类型集合封闭：

| PortDataType | 含义 | 现有对应 |
|---|---|---|
| `ReferenceImages` | 参考图集合（1–5 张内联图） | `UploadedImage[]` |
| `ProductImages` | 同一商品多角度图（2–3 张） | `UploadedImage[]` |
| `VisualRecipe` | 已确认的 12 字段视觉配方 | `VisualRecipe`（confirmedAt 必填） |
| `IdentityFeatureSet` | 已确认身份硬约束集合 | `IdentityFeature[]`（仅 confirmed） |
| `TaskPurpose` | 场景用途文本 | `string` |
| `CompiledPrompt` | 由配方/身份单向编译出的 Prompt | `CompiledPrompt` |
| `GeneratedImage` | 一次生成结果图 | `GenerationAttempt.image` |
| `AuditResult` | 四维验收结论 | `AuditResult` |
| `RepairPatch` | 定向修复受限补丁 | `RepairProposal` |
| `FinalImage` | 终稿（通过或人工接受） | 带版本号的图片 |

类型兼容规则：
- 边的起点/终点类型必须**相等**，或是下表中的隐式提升；不允许任意 any。
- 隐式提升只有一条：`GeneratedImage → FinalImage`（经“结果定稿”节点）。
- 一个输入端口同一时刻最多接一条入边（单源）；一个输出端口可接多条出边（扇出）。

### 3.2 节点定义（NodeDefinition）

```ts
type NodeKind =
  | 'source'        // 素材输入（参考图/商品图/用途）
  | 'analysis'      // 模型理解（配方提取/身份提取）
  | 'gate'          // 人工闸门（配方确认/身份确认/高风险修复确认）
  | 'transform'     // 纯本地确定性变换（Prompt 编译）
  | 'generation'    // 图片生成
  | 'audit'         // 结果验收
  | 'repair'        // 定向修复
  | 'sink';         // 结果定稿/输出

type NodePortDefinition = {
  portId: string;                 // 定义内稳定 id
  label: string;
  direction: 'in' | 'out';
  dataType: PortDataType;
  required?: boolean;             // 仅入端口：执行前必须有值
  multi?: boolean;                // 仅入端口：集合型（如多来源图片，首版仅图片允许）
};

type NodeConfigField = {
  key: string;
  label: string;
  dataType: 'string' | 'number' | 'enum' | 'boolean';
  enumValues?: string[];
  defaultValue: unknown;
  min?: number; max?: number;
};

type NodeDefinition = {
  type: string;                   // 'recipeExtractor' 等，封闭枚举，见 §4
  kind: NodeKind;
  title: string;
  category: '输入' | '理解' | '锁定' | '生成' | '验收' | '输出';
  summary: string;
  inputs: NodePortDefinition[];
  outputs: NodePortDefinition[];
  configFields: NodeConfigField[];
  /** 该节点是否是人工闸门（执行到此处必须暂停等人确认） */
  isHumanGate?: boolean;
  /** 对应的既有 runner / 纯函数；节点本身不发请求 */
  adapter: string;                // 指向注册表 §7
  removable: boolean;
  /** 每流程最多出现次数（修复=1，其余多数=Infinity 但受 DAG 限制） */
  maxInstances?: number;
};
```

### 3.3 节点实例与图

```ts
type NodeInstance = {
  id: string;                     // n_xxx
  type: NodeType;                 // 对应 NodeDefinition.type
  position: { x: number; y: number };
  config: Record<string, unknown>; // 仅允许该类型 configFields 声明的键
};

type Edge = {
  id: string;                     // e_xxx
  from: { node: string; port: string };
  to:   { node: string; port: string };
};

type WorkflowGraph = {
  nodes: NodeInstance[];
  edges: Edge[];
};
```

### 3.4 草稿与发布版本

```ts
type WorkflowDraft = {
  id: string;                     // wfd_xxx
  projectId: string;
  name: string;
  basedOnTemplateId: string | null;
  graph: WorkflowGraph;
  /** 最近一次图校验结果（草稿可带错保存） */
  validation: GraphValidationResult;
  createdAt: string;
  updatedAt: string;
  publishedVersionId: string | null; // 最近一次发布
};

type WorkflowVersion = {
  id: string;                     // wfv_<内容哈希前12位>
  projectId: string;
  name: string;
  versionNo: number;              // 项目内自增 v1、v2…
  graph: WorkflowGraph;           // 发布瞬间的深拷贝快照
  plan: ExecutionPlan;            // 发布时计算并固化的执行计划
  checksum: string;               // 规范化图的哈希
  createdAt: string;
  note?: string;
};
```

版本不可变：发布后任何节点/边/配置修改都产生**新版本**，运行记录永久引用其 `versionId`。禁止就地改写已发布版本。

---

## 4. 内置节点目录（首版封闭集合）

所有节点都映射到**已存在**的能力，不新增模型能力：

| type | kind/category | 关键入端口 | 关键出端口 | 适配器（既有能力） | 可删 |
|---|---|---|---|---|---|
| `referenceInput` | source/输入 | — | `ReferenceImages`,`TaskPurpose` | 本地（ImageUploader/用途输入） | 是（但无来源时图不可发布） |
| `productInput` | source/输入 | — | `ProductImages` | 本地 | 是 |
| `recipeExtractor` | analysis/理解 | `ReferenceImages` | `VisualRecipe(未确认)` | `runners.recipe`（runProbe 配方） | 是 |
| `recipeConfirmGate` | gate/锁定 | `VisualRecipe(未确认)` | `VisualRecipe` | 纯人审（confirmRecipe 语义） | 是* |
| `identityExtractor` | analysis/理解 | `ProductImages`,`ReferenceImages` | `IdentityFeatureSet(候选)` | `runners.identity` | 是 |
| `identityConfirmGate` | gate/锁定 | `IdentityFeatureSet(候选)` | `IdentityFeatureSet` | 逐条确认/跳过风险确认 | 是* |
| `promptCompiler` | transform/生成 | `VisualRecipe`,`IdentityFeatureSet`,`TaskPurpose` | `CompiledPrompt` | 纯函数 `compilePrompt` | 否（生成前必经） |
| `sceneGenerator` | generation/生成 | `CompiledPrompt` | `GeneratedImage` | `runners.image`（generateImage） | 是 |
| `resultAuditor` | audit/验收 | `GeneratedImage`,`ProductImages`,`VisualRecipe` | `AuditResult` | `runners.audit` | 是 |
| `targetedRepair` | repair/输出 | `AuditResult(failed)`,`CompiledPrompt` | `RepairPatch` | `runners.repair`（每图≤1，高风险 gate 内建） | 是，**每流程最多 1 个** |
| `finalSink` | sink/输出 | `FinalImage` | — | 本地定稿（含人工接受 warning/needs-review） | 否（终稿出口） |

\* 闸门节点可删除，删除后等价于今天的“跳过身份锁定（无硬约束，自担风险）”路径；删除时必须弹出风险确认，且 `recipeConfirmGate` 一旦删除，该图不得连接 `promptCompiler`（未确认配方不得编译——由连接校验强制，而非口头约束）。

首版**不开放**新增节点类型；节点库仅列出上表中与当前图兼容（按端口类型可连接）的类型。

---

## 5. 图校验（保存提示 + 发布硬门槛）

`validateGraph(graph): GraphValidationResult`，问题分三级：

```ts
type IssueLevel = 'error' | 'warning' | 'hint';
type GraphIssue = {
  level: IssueLevel;
  code: string;            // 机器可读，见下
  nodeId?: string; edgeId?: string;
  message: string;         // 面向用户、含下一步
};
type GraphValidationResult = {
  errors: GraphIssue[];    // 阻断发布与运行
  warnings: GraphIssue[];  // 可发布但需显式知情（如无身份硬约束）
  canPublish: boolean;
  requiredInputsSatisfied: boolean;
  isAcyclic: boolean;
};
```

### 5.1 错误（error，阻断）
- `E_PORT_TYPE_MISMATCH`：边两端数据类型不兼容。
- `E_INPUT_MULTI_SOURCE`：单源入端口接了多条边。
- `E_DANGLING_PORT`：必填入端口无连接（`required` 且无值）。
- `E_UNKNOWN_NODE_TYPE`：节点 type 不在注册表。
- `E_CONFIG_INVALID`：节点配置超出 schema 或越界。
- `E_CYCLE_DETECTED`：存在环（DFS 着色，返回构成环的节点路径）。
- `E_UNREACHABLE_SINK`：`finalSink` 无法从任一 source 到达。
- `E_SOURCE_WITHOUT_PATH`：存在 source 节点但到不了 sink（孤儿输入，warning 或 error：首版记 error，避免误传素材）。
- `E_UNCONFIRMED_RECIPE_TO_COMPILER`：`promptCompiler` 的 `VisualRecipe` 入边未经过 `recipeConfirmGate`。
- `E_REPAIR_LIMIT`：`targetedRepair` 实例数 > 1。
- `E_GATE_BYPASS_AMBIGUOUS`：同一数据既存在“过闸门”路径又存在“绕过闸门”路径汇入下游（防止用连线偷偷绕过确认）。

### 5.2 警告（warning，发布需勾选知情）
- `W_NO_IDENTITY_CONSTRAINTS`：无身份硬约束（删除/跳过 identity gate）。
- `W_AUDIT_SKIPPED`：图不含 `resultAuditor`（生成后无自动验收）。
- `W_NO_REPAIR`：验收失败没有修复分支（失败即终态）。

### 5.3 无环算法
对有向图做 DFS 三色标记（白/灰/黑）：遇到灰邻居即有环，回溯出环路径用于高亮。自连（节点输出接自己输入）同样拒绝。复杂度 O(V+E)。

### 5.4 连接时实时校验
用户拖出一条新连线时，目标端口即时判定类型是否兼容，不兼容则端口不高亮、连线不成立并给出原因 tooltip；不允许先连一条非法边再报错。

---

## 6. 执行计划与执行适配（核心：不造第三套引擎）

### 6.1 执行计划

```ts
type PlanStepKind =
  | 'local-input'     // 读取用户素材/用途
  | 'model-call'      // 调用既有 runner
  | 'local-transform' // 纯本地（compilePrompt）
  | 'human-gate'      // 暂停等人确认
  | 'conditional'     // 依据上一步 AuditResult 选择走修复还是定稿
  | 'sink';

type DataBinding = {
  // 本步骤某输入取值来自哪个节点实例的哪个出端口
  intoPort: string;
  fromNode: string;
  fromPort: string;
};

type ExecutionPlanStep = {
  stepId: string;
  nodeInstanceId: string;
  kind: PlanStepKind;
  adapter?: string;          // model-call/local-transform 时指向适配器
  bindings: DataBinding[];
  gate?: { kind: 'recipe' | 'identity' | 'repair-risk' };
  branch?: { onAudit: 'passed'|'warning'|'needs-review'|'failed'; gotoStep: string | null };
};

type ExecutionPlan = {
  steps: ExecutionPlanStep[];  // 拓扑序
  entryStepId: string;
  sinkStepId: string;
};
```

`planGraph(graph)`：拓扑排序（Kahn）→ 按节点 kind 生成步骤 → 计算绑定 → 插入闸门与条件分支。修复边（resultAuditor failed → targetedRepair → 回到 sceneGenerator 的重生）编译为 `conditional` 步骤，**这是唯一允许的“回跳”，在计划层是一次新的有序步骤，不是图中环**（图上表现为 repair→generator 的边，规划器识别为单步重生成，沿用现有 attempts V2 语义；仍受“每件最多修复一次”约束）。

### 6.2 GraphExecutor（薄编排，复用 runners）

GraphExecutor **不实现任何模型调用、Schema 或安全逻辑**。它：
1. 载入已固化 `ExecutionPlan`；
2. 维护每端口运行期取值表 `Map<nodePort, value>`；
3. 逐步执行：
   - `local-input/local-transform`：本地读写或调用 `compilePrompt`；
   - `model-call`：按 adapter 名从**唯一 runner 注册表**取函数（即今天的 `defaultRunners`），把绑定值装配成 runner 入参，调用并经现有 `assembleXxx` Zod 校验；
   - `human-gate`：把执行状态置为等待并持久化，返回，等用户动作后从该步恢复；
   - `conditional`：读取 `AuditResult.status` 决定下一步；
4. 每步产出仍写入今天的 `attempts/identityFeatures/recipe` 形状，使证据、诊断、raw 留存完全一致。

> 约束：runner 函数是唯一会发起模型请求的代码。图与 planner **不得** import 网络层，只依赖 runner 接口。这样自定义能力不会扩大 SSRF/注入面。

### 6.3 与现有单件逻辑的关系
- 现有 `orchestrator.ts` 的 `analyze / generateFirst / proposeRepair / applyRepairAndRegenerate` 是“固定顺序脚本”。
- 新增 GraphExecutor 后，标准模板规划出的计划必须与这些脚本的**调用次序与闸门位置完全一致**（用黄金用例锁定：同输入下步骤序列相同）。
- 迁移期保留 orchestrator 供历史运行记录只读复现；**新运行一律走 GraphExecutor**。单件 hook `useSingleItemWorkflow` 内部从“调 orchestrator”切换为“驱动 GraphExecutor”，对外暴露的动作名（确认配方/逐条确认/生成/修复/接受）保持不变，使画布检查器无需重写。

### 6.4 与批量引擎的关系
- `BatchEngine` 增加字段 `workflowVersionId`，每商品的执行体从内嵌固定序列改为“按同一版本 plan 推进的 GraphExecution”。
- 并发信号量（分析 2 / 生成 1）、错误隔离、连续网络失败升级系统暂停、`interrupted 不自动续跑` 等机制**原样保留**。
- 批量只能选择**已发布版本**，不能选草稿（对应旧需求“批量绑定不可变快照”）。
- 批量预算估算从计划的 `model-call` 步骤数推导（标准模板仍是 4/7）。

---

## 7. 节点注册与适配器接口（关键接口）

```ts
// 唯一的模型调用单元注册表（沿用现有 defaultRunners，补统一接口名）
interface NodeAdapterContext {
  settings: ModelSettings;
  inputs: Record<string, unknown>;   // 已按绑定填充
  config: Record<string, unknown>;
  signal?: AbortSignal;
}
interface NodeAdapter<TOut = unknown> {
  readonly id: string;
  run(ctx: NodeAdapterContext): Promise<
    | { ok: true; data: TOut; raw?: RawModelCall }
    | SafeError
  >;
}
```

- 适配器由系统在启动时注册（内置、静态、不可序列化进工作流；工作流只存 adapterId 字符串）。
- 节点定义与适配器分离：同一 `sceneGenerator` 定义只有一个适配器，用户不能替换其实现。
- Prompt 编译这类无副作用步骤是 `LocalNodeAdapter`，与模型适配器同接口但不接受 settings 网络能力。

---

## 8. 草稿 / 版本生命周期

```
新建项目 → 从模板 standard-still-life-v1 复制为草稿 Draft(v0)
编辑（增删节点/连线/配置）→ 随时保存（可带 error）
点击“发布” → validateGraph
   ├─ 有 error：定位到首个错误节点，禁止发布
   └─ 无 error（warning 需勾选知情）→ 深拷贝 + planGraph + checksum
         → WorkflowVersion vN（不可变）→ 项目标记 publishedVersionId
单件试运行：可选“用草稿（仅当无 error）”或“用已发布版本”
批量运行：仅可选用已发布版本
再次编辑 → 基于某版本复制成新草稿 → 发布为 vN+1（旧版本与旧运行永久可追溯）
```

- 版本比较：提供“vN ↔ vN+1 差异”（新增/删除节点、配置变化、连接变化）。
- 回退：可把任一历史版本“复制为新草稿”再发布（产生新版本号，不覆盖历史）。

---

## 9. 首版执行表达力边界

- 支持：线性 DAG、单条件修复回跳（编译为顺序重生）、单源/扇出、人审暂停。
- 暂不支持：多分支并行、join、循环、子图、动态迭代次数、定时器/触发器。
- 当用户连线超出表达力（如试图构造真正的环），连接被拒绝并说明“首版不支持循环，修复失败的重生已由定向修复节点表达”。

---

## 10. 模板与迁移

### 10.1 出厂模板
- `standard-still-life-v1`：即今天的 7 节点固定主干（参考图/商品图→配方提取+确认/身份提取+确认→Prompt 编译→生成→验收→(失败)修复→定稿）。内置、只读、不可删除。
- 后续可加 `recipe-only-v1`（仅提取配方不出图）等模板，但本轮只交付标准模板。

### 10.2 数据迁移（DB v4，详见 docs/11 §迁移附录）
- 新增 store：`workflowDrafts`、`workflowVersions`、`templates`（模板不落库，代码内置）。
- 每个现存 Project：生成一份标准模板草稿与一个已发布 v1，`project.publishedVersionId` 指向它；旧 `wf:<pid>` / `batch:<pid>` 作为**历史运行数据保留**，不强制改写。
- 旧 `WorkflowDefinition`（fixedWorkflow）保留为模板的图工厂，是模板内容的唯一来源，避免两份事实。
- `Batch.definition` 旧字段降级为“当时所用模板”的引用快照；旧批次仍可只读查看。

### 10.3 回滚
- 所有新数据写入新 store / 新字段；v4 升级只增 store 与键，不删除旧键。代码回退到 v3 时旧项目仍可打开（忽略新 store）。
- 发布版本不可变使“运行结果无法用其定义复现”的风险被消除：结果始终带 `workflowVersionId`。

---

## 11. 安全边界（不变且强制进校验/执行）

1. 节点类型封闭、内置；无代码/Shell/任意 HTTP/文件节点。
2. 图必须无环；唯一“回跳”是计划层的修复重生，且每件最多一次。
3. 模型不接收也不返回 URL / 文件路径 / 节点类型选择；外部 URL 图片仍由代理层深度过滤（见既有安全实现）。
4. 每个模型步骤的输出经既有 Zod Schema 装配，失败即该步失败，绝不伪装成功。
5. 未确认配方不能进 Prompt 编译（图级强制）；修复 Patch 不能改写已确认配方与身份（runner 层既有约束保留）。
6. 高风险修复仍以代码计算的 `isHighRiskAudit` 为准并强制人工确认，模型无权自判风险。
7. 画布上的任何连线/配置都不能改变出站主机白名单、Key 存储位置或代理字段过滤。
8. 不提供“模拟节点执行”：未配置模型时图可编辑、可发布、可校验，但模型步骤不可运行；不播放假动画、不生成假结果。

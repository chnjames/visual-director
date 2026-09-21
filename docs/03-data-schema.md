# 核心数据模型

以下类型是产品合同，开发模型可以补充实现字段，但不得改变核心语义。

```ts
type Evidence = {
  sourceId: string;
  sourceType: 'product-image' | 'reference-image' | 'user-text';
  region?: { x: number; y: number; width: number; height: number };
  quote?: string;
  confidence: number;
};

type RecipeFieldKey =
  | 'subjectPlacement'
  | 'subjectScale'
  | 'cameraAngle'
  | 'shotAndDepth'
  | 'composition'
  | 'backgroundType'
  | 'environmentElements'
  | 'lightDirection'
  | 'lightQuality'
  | 'palette'
  | 'materialRendering'
  | 'mood';

type RecipeField = {
  key: RecipeFieldKey;
  value: string;
  confidence: number;
  evidence: Evidence[];
  locked: boolean;
};

type VisualRecipe = {
  id: string;
  name: string;
  fields: RecipeField[];
  required: string[];
  variable: string[];
  forbidden: string[];
  confirmedAt?: string;
};

type IdentityFeature = {
  id: string;
  category: 'shape' | 'part' | 'color' | 'material' | 'logo' | 'texture';
  statement: string;
  source: 'model-proposed' | 'user-declared';
  evidence: Evidence[];
  status: 'pending' | 'confirmed' | 'rejected';
  severityIfViolated: 'critical' | 'major' | 'minor';
};

type ProductBatchItem = {
  id: string;
  name: string;
  imageIds: string[];
  identityFeatures: IdentityFeature[];
  state: BatchState;
  currentNodeId?: string;
  retryCount: number;
  lastError?: SafeError;
};

type WorkflowDefinition = {
  id: string;
  name: string;
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  recipeId: string;
  inputSchema: InputField[];
  outputSchema: OutputField[];
};

type AuditStatus = 'passed' | 'warning' | 'failed' | 'needs-review';

type AuditResult = {
  productId: string;
  status: AuditStatus;
  identityScore: number;
  recipeScore: number;
  taskScore: number;
  technicalScore: number;
  criticalViolation: boolean;
  issues: AuditIssue[];
  modelConfidence: number;
};
```

## 存储原则

- 项目、图片、配方、工作流和任务状态存入浏览器IndexedDB。
- API Key只进入sessionStorage，不得进入项目JSON。
- 画布与批量页面共享WorkflowDefinition。
- 用户导出的JSON必须带schemaVersion。
- 模型原始输出与解析结果分开保存，便于证据和诊断。


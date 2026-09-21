/**
 * 只读样例数据入口。
 *
 * 重要诚信规则（docs/01、docs/07）：
 * - 预置案例只允许读取“真实保存的运行结果”；
 * - 在尚未产生任何真实模型运行之前，这里必须保持为空数组，
 *   界面据此显示“等待真实运行”，不得伪造样例、不得播放模拟调用动画。
 *
 * 阶段2 起，真实运行（含原始输出、解析结果、Schema 状态、证据、诊断）
 * 经用户确认后可按 SavedRun 结构追加到此处（或导入真实保存文件）。
 */
import type {
  AuditResult,
  IdentityFeature,
  RawModelCall,
  VisualRecipe,
} from '../shared/types';

export type SavedRun = {
  id: string;
  savedAt: string;
  note: string;
  recipe?: { value: VisualRecipe; raw: RawModelCall };
  identity?: { productName: string; value: IdentityFeature[]; raw: RawModelCall };
  audit?: { value: AuditResult; raw: RawModelCall };
};

/**
 * 当前没有任何真实保存的运行 → 长度为 0。
 * 严禁为了“演示效果”手工填入未经真实模型运行与人工核对的内容。
 */
export const SAVED_RUNS: SavedRun[] = [];

export const SAMPLE_POLICY_NOTE =
  '预置案例仅展示真实保存的运行结果。当前尚无真实运行，状态为“等待真实运行”，本产品不提供伪造样例。';

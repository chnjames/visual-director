/**
 * 图片输入工具：本地文件 → data URI（仅在会话内存与请求体中使用）。
 *
 * 关键：上传前在浏览器端缩放/压缩，避免把数 MB～数十 MB 的手机原图以 base64 直传，
 * 否则仅上传就可能超过代理超时（这是“测试连接正常、跑探针却一直超时”的根因之一）。
 * - 最长边超过 MAX_EDGE 或原图超过 RECOMPRESS_BYTES 时，等比缩放并转 JPEG；
 * - 白底，避免透明 PNG 转 JPEG 变黑；
 * - 逐级降低质量，把单图请求体积压到 TARGET_BYTES 附近；
 * - 小图与非浏览器环境（如单测 jsdom 无 canvas）保持原样，不做破坏性处理。
 * 不抓取任何外部平台图片，不产生服务器持久文件。
 */
import type { UploadedImage } from '../shared/types';

const ALLOWED_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/jpg'];
const MAX_BYTES = 12 * 1024 * 1024; // 原始文件 12MB 上限，超出给出明确错误
const MAX_EDGE = 1568; // 视觉模型推荐的较长边上限附近，足够保留证据细节
const RECOMPRESS_BYTES = 1_500_000; // 超过约 1.5MB 才重编码，小图/截图保持原样
const TARGET_BYTES = 2_500_000; // 压缩目标：单图请求体积约 2.5MB 内
const QUALITIES = [0.85, 0.72, 0.6];

let seq = 0;
export function nextImageId(): string {
  seq += 1;
  return `img_${Date.now().toString(36)}_${seq}`;
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`读取图片失败: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function dataUriBytes(dataUri: string): number {
  const comma = dataUri.indexOf(',');
  const b64 = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  return Math.floor((b64.length * 3) / 4);
}

function loadImage(src: string): Promise<{ width: number; height: number; img: unknown }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, img });
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

function canUseCanvas(): boolean {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return false;
  const canvas = document.createElement('canvas');
  return typeof canvas.getContext === 'function' && !!canvas.getContext('2d');
}

type Processed = { dataUri: string; mediaType: string; width?: number; height?: number; bytes: number };

/** 在浏览器端等比缩放/压缩；环境不支持或无需处理时返回原图信息 */
async function processImage(rawDataUri: string, file: File): Promise<Processed> {
  const originalType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  if (!canUseCanvas()) {
    return { dataUri: rawDataUri, mediaType: originalType, bytes: file.size };
  }
  const { img, width, height } = await loadImage(rawDataUri);
  const needScale = Math.max(width, height) > MAX_EDGE;
  const needShrink = file.size > RECOMPRESS_BYTES;
  if (!needScale && !needShrink) {
    return { dataUri: rawDataUri, mediaType: originalType, width, height, bytes: file.size };
  }

  const scale = needScale ? MAX_EDGE / Math.max(width, height) : 1;
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataUri: rawDataUri, mediaType: originalType, width, height, bytes: file.size };
  // 白底，避免透明通道转 JPEG 变黑
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(img as CanvasImageSource, 0, 0, targetW, targetH);

  let dataUri = canvas.toDataURL('image/jpeg', QUALITIES[0]);
  if (dataUriBytes(dataUri) > TARGET_BYTES) {
    for (const q of QUALITIES.slice(1)) {
      const candidate = canvas.toDataURL('image/jpeg', q);
      dataUri = candidate;
      if (dataUriBytes(candidate) <= TARGET_BYTES) break;
    }
  }
  return {
    dataUri,
    mediaType: 'image/jpeg',
    width: targetW,
    height: targetH,
    bytes: dataUriBytes(dataUri),
  };
}

export async function readImageFile(file: File): Promise<UploadedImage> {
  if (!ALLOWED_MEDIA.includes(file.type)) {
    throw new Error(`不支持的图片类型: ${file.type || '未知'}（仅支持 PNG/JPEG/WebP）`);
  }
  if (file.size > MAX_BYTES) {
    throw new Error(`图片过大: ${(file.size / 1024 / 1024).toFixed(1)}MB，上限 12MB`);
  }
  const rawDataUri = await readAsDataURL(file);
  try {
    const p = await processImage(rawDataUri, file);
    return {
      id: nextImageId(),
      dataUri: p.dataUri,
      mediaType: p.mediaType,
      name: file.name,
      bytes: p.bytes,
      width: p.width,
      height: p.height,
    };
  } catch {
    // 压缩失败不阻断：退回原图 data URI（仍受原始 12MB 上限约束）
    return {
      id: nextImageId(),
      dataUri: rawDataUri,
      mediaType: file.type === 'image/jpg' ? 'image/jpeg' : file.type,
      name: file.name,
      bytes: file.size,
    };
  }
}

/** 组装为 OpenAI 兼容的多模态 content 片段 */
export function imagesToContent(images: UploadedImage[]): unknown[] {
  return images.map((img) => ({
    type: 'image_url',
    image_url: { url: img.dataUri },
  }));
}

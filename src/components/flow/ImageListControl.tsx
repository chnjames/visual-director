/**
 * 节点内图片列表。只读本地文件，经浏览器压缩后写入节点配置，不抓取外链。
 */
import { useId, useState } from 'react';
import { Images, X } from 'lucide-react';
import { readImageFile } from '../../model/images';
import { readUploadedImages } from '../../workflow/graph/execute';
import type { UploadedImage } from '../../shared/types';
import { ImageLightbox } from './ImageLightbox';

export function ImageListControl({
  value,
  max,
  addLabel,
  onChange,
  disabled = false,
  disabledReason,
}: {
  value: unknown;
  max: number;
  addLabel: string;
  onChange: (images: UploadedImage[]) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const images = readUploadedImages(value);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || disabled) return;
    setError(null);
    const room = max - images.length;
    if (room <= 0) {
      setError(`最多 ${max} 张`);
      return;
    }
    const list = Array.from(files).slice(0, room);
    if (files.length > room) setError(`最多 ${max} 张，已忽略超出的图片`);
    const added: UploadedImage[] = [];
    setProcessing(true);
    try {
      for (const file of list) {
        try {
          added.push(await readImageFile(file));
        } catch (e) {
          setError((e as Error).message);
        }
      }
      if (added.length) onChange([...images, ...added].slice(0, max));
    } finally {
      setProcessing(false);
    }
  }

  const unavailable = disabled || processing || images.length >= max;
  return (
    <div
      className={`if-images nodrag ${dragging ? 'is-dragging' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!unavailable) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!unavailable) void handleFiles(event.dataTransfer.files);
      }}
    >
      <label
        className="if-upload"
        htmlFor={inputId}
        aria-disabled={unavailable}
        onClick={(event) => {
          event.stopPropagation();
          if (unavailable) event.preventDefault();
        }}
        data-testid="node-image-upload"
        title={disabled ? disabledReason : undefined}
      >
        <Images size={14} />
        {processing ? '正在处理图片…' : `${addLabel}（${images.length}/${max}）`}
        <span>点击选择或拖到这里</span>
      </label>
      <input
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="if-file-input"
        disabled={unavailable}
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.currentTarget.value = '';
        }}
      />
      {disabled && disabledReason && <p className="hint">{disabledReason}</p>}
      {error && <p className="hint err">{error}</p>}
      {images.length > 0 && (
        <div className="thumbs mini">
          {images.map((img, index) => (
            <div className="thumb" key={img.id}>
              <button
                type="button"
                className="thumb-zoom"
                aria-label={`放大查看 ${img.name}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewIndex(index);
                }}
              >
                <img src={img.dataUri} alt={img.name} />
              </button>
              {!disabled && (
                <button
                  type="button"
                  className="if-remove"
                  aria-label={`移除 ${img.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(images.filter((x) => x.id !== img.id));
                  }}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {previewIndex !== null && (
        <ImageLightbox
          images={images}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onIndex={setPreviewIndex}
        />
      )}
    </div>
  );
}

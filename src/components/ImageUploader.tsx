import { useRef, useState } from 'react';
import { readImageFile } from '../model/images';
import type { UploadedImage } from '../shared/types';

type Props = {
  images: UploadedImage[];
  setImages: (imgs: UploadedImage[]) => void;
  min: number;
  max: number;
  label: string;
};

export function ImageUploader({ images, setImages, min, max, label }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    const room = max - images.length;
    const list = Array.from(files).slice(0, Math.max(room, 0));
    if (files.length > room) {
      setError(`最多上传 ${max} 张，已忽略超出的图片`);
    }
    const added: UploadedImage[] = [];
    for (const file of list) {
      try {
        added.push(await readImageFile(file));
      } catch (e) {
        setError((e as Error).message);
      }
    }
    if (added.length) setImages([...images, ...added].slice(0, max));
    if (inputRef.current) inputRef.current.value = '';
  }

  function remove(id: string) {
    setImages(images.filter((i) => i.id !== id));
  }

  const enough = images.length >= min && images.length <= max;

  function fmtSize(bytes?: number): string {
    if (!bytes) return '';
    return bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(2)}MB`
      : `${Math.round(bytes / 1024)}KB`;
  }

  return (
    <div className="uploader">
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => inputRef.current?.click()}
          disabled={images.length >= max}
        >
          选择图片
        </button>
        <span className="hint">
          {label}（{min}-{max} 张，当前 {images.length} 张）
        </span>
        {enough ? (
          <span className="badge confirmed">数量符合</span>
        ) : (
          <span className="badge pending">待满足</span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      {error && <p className="hint err">{error}</p>}
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((img, i) => (
            <div className="thumb" key={img.id}>
              <img src={img.dataUri} alt={img.name} />
              <button type="button" className="rm" onClick={() => remove(img.id)}>
                ×
              </button>
              <div className="name">
                {i + 1}. {img.name}
              </div>
              {(img.width || img.bytes) && (
                <div className="name" style={{ fontWeight: 400, opacity: 0.75 }}>
                  {img.width ? `${img.width}×${img.height} · ` : ''}
                  {fmtSize(img.bytes)}（已压缩）
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

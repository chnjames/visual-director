import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export type PreviewImage = {
  dataUri: string;
  mediaType: string;
  name?: string;
};

export function readPreviewImages(value: unknown): PreviewImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const dataUri = (item as { dataUri?: unknown }).dataUri;
    if (typeof dataUri !== 'string') return [];
    const mediaType =
      typeof (item as { mediaType?: unknown }).mediaType === 'string'
        ? (item as { mediaType: string }).mediaType
        : 'image/png';
    const name =
      typeof (item as { name?: unknown }).name === 'string'
        ? (item as { name: string }).name
        : undefined;
    return [{ dataUri, mediaType, name }];
  });
}

export function ImageLightbox({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: PreviewImage[];
  index: number;
  onClose: () => void;
  onIndex?: (next: number) => void;
}) {
  const current = images[index];
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && images.length > 1) {
        onIndex?.((index - 1 + images.length) % images.length);
      }
      if (e.key === 'ArrowRight' && images.length > 1) {
        onIndex?.((index + 1) % images.length);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, index, onClose, onIndex]);

  if (!current || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-label="查看图片"
      data-testid="image-lightbox"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button type="button" className="image-lightbox-close" aria-label="关闭预览" onClick={onClose}>
        <X size={18} />
      </button>
      {images.length > 1 && (
        <button
          type="button"
          className="image-lightbox-nav prev"
          aria-label="上一张"
          onClick={() => onIndex?.((index - 1 + images.length) % images.length)}
        >
          <ChevronLeft size={22} />
        </button>
      )}
      <img src={current.dataUri} alt={current.name || `预览 ${index + 1}`} />
      {images.length > 1 && (
        <button
          type="button"
          className="image-lightbox-nav next"
          aria-label="下一张"
          onClick={() => onIndex?.((index + 1) % images.length)}
        >
          <ChevronRight size={22} />
        </button>
      )}
      <span className="image-lightbox-count">
        {index + 1} / {images.length}
      </span>
    </div>,
    document.body,
  );
}

export function ZoomableThumbs({
  images,
  className = 'thumbs mini',
  altPrefix = '图片',
}: {
  images: PreviewImage[];
  className?: string;
  altPrefix?: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (!images.length) return null;
  return (
    <>
      <div className={className}>
        {images.map((image, index) => (
          <button
            key={`${image.dataUri.slice(-18)}-${index}`}
            type="button"
            className="thumb thumb-zoom"
            aria-label={`放大查看${altPrefix} ${index + 1}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setOpenIndex(index);
            }}
          >
            <img src={image.dataUri} alt={image.name || `${altPrefix} ${index + 1}`} />
          </button>
        ))}
      </div>
      {openIndex !== null && (
        <ImageLightbox
          images={images}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          onIndex={setOpenIndex}
        />
      )}
    </>
  );
}

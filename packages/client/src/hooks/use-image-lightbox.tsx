import { useCallback, useState } from 'react';

import { ImageLightbox } from '@/components/ImageLightbox';

interface LightboxImage {
  src: string;
  alt: string;
}

/**
 * Bundles the lightbox state, the openLightbox handler, and the
 * `<ImageLightbox>` element together. The component reads the rendered
 * dialog from `lightbox` so the parent doesn't need to import ImageLightbox
 * directly.
 */
export function useImageLightbox() {
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<LightboxImage[]>([]);
  const [index, setIndex] = useState(0);

  const openLightbox = useCallback((nextImages: LightboxImage[], nextIndex: number) => {
    setImages(nextImages);
    setIndex(nextIndex);
    setOpen(true);
  }, []);

  const lightbox = (
    <ImageLightbox
      images={images}
      initialIndex={index}
      open={open}
      onClose={() => setOpen(false)}
    />
  );

  return { openLightbox, lightbox };
}

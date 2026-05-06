import { useMemo } from 'react';

import { MediaPreview } from '@/components/MediaPreview';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface MediaPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absolute filesystem path to the media file. */
  filePath: string | null;
}

export function MediaPreviewDialog({ open, onOpenChange, filePath }: MediaPreviewDialogProps) {
  const fileName = useMemo(() => {
    if (!filePath) return undefined;
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? filePath : filePath.slice(idx + 1);
  }, [filePath]);

  const src = useMemo(() => {
    if (!filePath) return null;
    return `/api/files/raw?path=${encodeURIComponent(filePath)}`;
  }, [filePath]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] w-[90vw] max-w-5xl flex-col gap-3 p-4"
        data-testid="media-preview-dialog"
      >
        <DialogHeader>
          <DialogTitle className="truncate text-sm font-medium">
            {fileName ?? 'Preview'}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {src && filePath && <MediaPreview src={src} name={fileName} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

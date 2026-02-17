import { memo, useMemo } from 'react';
import { motion } from 'motion/react';
import { User, FileText, ImageIcon } from 'lucide-react';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';

interface StickyUserMessageProps {
  content: string;
  images?: { source: { media_type: string; data: string } }[];
  onScrollTo: () => void;
}

export const StickyUserMessage = memo(function StickyUserMessage({
  content,
  images,
  onScrollTo,
}: StickyUserMessageProps) {
  const { files, cleanContent } = useMemo(() => parseReferencedFiles(content), [content]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="absolute top-0 left-0 right-0 z-20 px-4 pointer-events-none"
    >
      <div className="mx-auto max-w-3xl min-w-[320px] pointer-events-auto">
        <button
          onClick={onScrollTo}
          className="w-full flex items-start gap-2 rounded-b-lg border border-t-0 bg-foreground/95 text-background backdrop-blur-sm px-3 py-2 shadow-lg cursor-pointer hover:bg-foreground transition-colors text-left"
        >
          <User className="h-3 w-3 text-background/60 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1">
                {files.map((file) => (
                  <span
                    key={file}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono bg-background/20 rounded text-background/70"
                    title={file}
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    {file.split('/').pop()}
                  </span>
                ))}
              </div>
            )}
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-background line-clamp-5 break-words">
              {cleanContent.trim()}
            </pre>
            {images && images.length > 0 && (
              <div className="flex gap-1.5 mt-1.5">
                {images.map((img, idx) => (
                  <img
                    key={idx}
                    src={`data:${img.source.media_type};base64,${img.source.data}`}
                    alt={`Attachment ${idx + 1}`}
                    className="h-8 w-8 rounded object-cover border border-background/20"
                  />
                ))}
                {images.length > 3 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-background/60">
                    <ImageIcon className="h-3 w-3" />
                    +{images.length - 3}
                  </span>
                )}
              </div>
            )}
          </div>
        </button>
      </div>
    </motion.div>
  );
});

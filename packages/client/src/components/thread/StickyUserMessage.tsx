import { memo, useMemo } from 'react';
import { motion } from 'motion/react';
import { User, FileText } from 'lucide-react';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';

interface StickyUserMessageProps {
  content: string;
  onScrollTo: () => void;
}

export const StickyUserMessage = memo(function StickyUserMessage({
  content,
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
          className="w-full flex items-start gap-2 rounded-b-lg border border-t-0 bg-muted/95 backdrop-blur-sm px-3 py-2 shadow-lg cursor-pointer hover:bg-muted transition-colors text-left"
        >
          <User className="h-3 w-3 text-foreground/60 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1">
                {files.map((file) => (
                  <span
                    key={file}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono bg-background/50 rounded text-muted-foreground"
                    title={file}
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    {file.split('/').pop()}
                  </span>
                ))}
              </div>
            )}
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground line-clamp-5 break-words">
              {cleanContent.trim()}
            </pre>
          </div>
        </button>
      </div>
    </motion.div>
  );
});

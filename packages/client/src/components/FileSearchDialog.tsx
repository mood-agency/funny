import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { HighlightText } from '@/components/ui/highlight-text';
import { api } from '@/lib/api';
import { FileExtensionIcon } from '@/lib/file-icons';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

interface FileSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface BrowseFile {
  path: string;
  type: 'file' | 'folder';
}

const DEBOUNCE_MS = 150;

export function FileSearchDialog({ open, onOpenChange }: FileSearchDialogProps) {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === selectedProjectId);
  const activeThread = useThreadStore((s) => s.activeThread);

  // Use worktree path when thread is in worktree mode, otherwise fall back to project path
  const basePath = activeThread?.worktreePath || project?.path;

  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<BrowseFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const requestIdRef = useRef(0);

  // Search files from server (debounced)
  const searchFiles = useCallback(
    async (searchQuery: string) => {
      if (!basePath) return;

      const requestId = ++requestIdRef.current;
      setLoading(true);

      const result = await api.browseFiles(basePath, searchQuery || undefined);

      // Ignore stale responses
      if (requestId !== requestIdRef.current) return;

      if (result.isOk()) {
        const normalized: BrowseFile[] = result.value.files.map((f) =>
          typeof f === 'string' ? { path: f, type: 'file' as const } : f,
        );
        setFiles(normalized);
        setTruncated(result.value.truncated);
      }
      setLoading(false);
    },
    [basePath],
  );

  // Fetch initial files when dialog opens
  useEffect(() => {
    if (!open || !basePath) return;
    searchFiles('');
    return () => {
      requestIdRef.current++;
    };
  }, [open, basePath, searchFiles]);

  // Debounced search on query change
  useEffect(() => {
    if (!open || !basePath) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchFiles(query);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, basePath, searchFiles]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setFiles([]);
      setTruncated(false);
    }
  }, [open]);

  const handleSelect = useCallback(
    (relativePath: string) => {
      if (!basePath) return;
      onOpenChange(false);
      const absolutePath = `${basePath}/${relativePath}`;
      useInternalEditorStore.getState().openFile(absolutePath);
    },
    [onOpenChange, basePath],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-[50%] top-[20%] z-50 w-full max-w-lg translate-x-[-50%] overflow-hidden rounded-lg border bg-card p-0 shadow-xl data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in"
        >
          <DialogTitle className="sr-only">{t('fileSearch.title', 'Search files')}</DialogTitle>
          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5"
          >
            <CommandInput
              data-testid="file-search-input"
              placeholder={t('fileSearch.placeholder', 'Search files by name...')}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {!basePath ? (
                  <span>{t('fileSearch.noProject', 'Select a project first')}</span>
                ) : loading ? (
                  <div className="flex items-center justify-center gap-2">
                    <Loader2 className="icon-sm animate-spin" />
                    <span>{t('fileSearch.searching', 'Searching...')}</span>
                  </div>
                ) : (
                  <span>{t('fileSearch.noResults', 'No files found')}</span>
                )}
              </CommandEmpty>
              {files.length > 0 && (
                <CommandGroup heading={t('fileSearch.files', 'Files')}>
                  {files.map((file) => (
                    <CommandItem
                      key={file.path}
                      data-testid={`file-search-item-${file.path}`}
                      value={file.path}
                      onSelect={() => handleSelect(file.path)}
                    >
                      <FileExtensionIcon filePath={file.path} className="icon-base flex-shrink-0" />
                      <HighlightText
                        text={getFileName(file.path)}
                        query={query}
                        className="truncate text-xs"
                      />
                      <span className="truncate text-xs text-muted-foreground">{file.path}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {truncated && (
                <div className="px-2 py-1.5 text-center text-xs text-muted-foreground">
                  {t('fileSearch.truncated', 'Showing first 100 results — refine your search')}
                </div>
              )}
            </CommandList>
          </Command>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

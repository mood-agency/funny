import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { Loader2, Plus, Send } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { toastError } from '@/lib/toast-error';
import { useProjectStore } from '@/stores/project-store';
import { deriveToolLists, useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';

import { ProjectPickerPopover } from './ProjectPickerPopover';

const log = createClientLogger('EmptyGridCell');

interface Props {
  cellIndex: number;
  onCreated: (threadId: string) => void;
}

/**
 * Empty grid cell — pick a project, type a prompt, then create a thread with
 * the prompt as the title (same flow as the main thread creation).
 */
export const EmptyGridCell = memo(function EmptyGridCell({ cellIndex, onCreated }: Props) {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const [creating, setCreating] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selectedProjectData = selectedProject
    ? projects.find((p) => p.id === selectedProject)
    : null;

  const handleSelectProject = useCallback((pid: string) => {
    setSelectedProject(pid);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!selectedProject || !prompt.trim() || creating) return;
    setCreating(true);

    const project = projects.find((p) => p.id === selectedProject);
    const mode = project?.defaultMode || DEFAULT_THREAD_MODE;
    const model = project?.defaultModel || 'sonnet';
    const provider = project?.defaultProvider || 'claude';
    const { allowedTools, disallowedTools } = deriveToolLists(
      useSettingsStore.getState().toolPermissions,
    );

    const result = await api.createThread({
      projectId: selectedProject,
      title: prompt.trim().slice(0, 200),
      mode,
      provider,
      model,
      prompt: prompt.trim(),
      allowedTools,
      disallowedTools,
    });

    if (result.isErr()) {
      toastError(result.error);
      setCreating(false);
      return;
    }

    const threadId = result.value.id;
    log.info(
      { cellIndex, projectId: selectedProject, threadId },
      'grid thread created with prompt',
    );
    await loadThreadsForProject(selectedProject);
    onCreated(threadId);
    setCreating(false);
    setSelectedProject(null);
    setPrompt('');
  }, [selectedProject, prompt, creating, projects, loadThreadsForProject, onCreated, cellIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === 'Escape') {
        setSelectedProject(null);
        setPrompt('');
      }
    },
    [handleSubmit],
  );

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-sm border-2 border-dashed border-border/60 bg-muted/10 p-4 transition-colors hover:border-primary/50 hover:bg-muted/30"
      data-testid={`grid-empty-cell-${cellIndex}`}
    >
      {creating ? (
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/40" />
      ) : selectedProject ? (
        <div className="flex w-full max-w-sm flex-col gap-2">
          <div className="text-xs text-muted-foreground">
            {selectedProjectData?.name ?? t('live.newThread', 'New thread')}
          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('thread.promptPlaceholder', 'What should the agent do?')}
            className="min-h-[80px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid={`grid-empty-prompt-${cellIndex}`}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setSelectedProject(null);
                setPrompt('');
              }}
              data-testid={`grid-empty-cancel-${cellIndex}`}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-7"
              disabled={!prompt.trim()}
              onClick={handleSubmit}
              data-testid={`grid-empty-submit-${cellIndex}`}
            >
              <Send className="icon-xs mr-1" />
              {t('common.send', 'Send')}
            </Button>
          </div>
        </div>
      ) : (
        <ProjectPickerPopover
          placeholder={t('kanban.searchProject', 'Search project...')}
          onSelect={handleSelectProject}
          trigger={
            <Button
              variant="default"
              size="sm"
              className="h-7"
              data-testid={`grid-empty-new-${cellIndex}`}
            >
              <Plus className="icon-sm" />
              {t('live.newThread', 'New thread')}
            </Button>
          }
        />
      )}
    </div>
  );
});

import { Loader2, Plus } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { createClientLogger } from '@/lib/client-logger';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { createDraftThread } from './draft-thread';
import { ProjectPickerPopover } from './ProjectPickerPopover';

const log = createClientLogger('EmptyGridCell');

interface Props {
  cellIndex: number;
  onCreated: (threadId: string) => void;
}

/**
 * Empty grid cell — opens a project picker; once a project is chosen, a
 * draft thread is created in this cell, ready for the user to write the
 * first prompt.
 */
export const EmptyGridCell = memo(function EmptyGridCell({ cellIndex, onCreated }: Props) {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const [creating, setCreating] = useState(false);

  const handleSelectProject = useCallback(
    async (pid: string) => {
      if (creating) return;
      setCreating(true);
      const project = projects.find((p) => p.id === pid);
      const threadId = await createDraftThread(pid, project?.defaultMode);
      if (threadId) {
        log.info({ cellIndex, projectId: pid, threadId }, 'inline grid draft thread created');
        await loadThreadsForProject(pid);
        onCreated(threadId);
      }
      setCreating(false);
    },
    [creating, projects, loadThreadsForProject, onCreated, cellIndex],
  );

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-sm border-2 border-dashed border-border/60 bg-muted/10 p-4 transition-colors hover:border-primary/50 hover:bg-muted/30"
      data-testid={`grid-empty-cell-${cellIndex}`}
    >
      {creating ? (
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/40" />
      ) : (
        <>
          <Plus className="h-8 w-8 text-muted-foreground/40" />
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
                {t('live.selectProject', 'Select project')}
              </Button>
            }
          />
        </>
      )}
    </div>
  );
});

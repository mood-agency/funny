import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { Plus, Trash2 } from 'lucide-react';
import type { Thread, ThreadStage } from '@a-parallel/shared';
import { useAppStore } from '@/stores/app-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { stageConfig, statusConfig, gitSyncStateConfig, timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface KanbanViewProps {
  threads: Thread[];
  projectId?: string;
}

const STAGES: ThreadStage[] = ['backlog', 'in_progress', 'review', 'done'];

function KanbanCard({ thread, projectInfo, onDelete }: { thread: Thread; projectInfo?: { name: string; color?: string }; onDelete: (thread: Thread) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const statusByThread = useGitStatusStore((s) => s.statusByThread);
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    return draggable({
      element: el,
      getInitialData: () => ({
        type: 'kanban-card',
        threadId: thread.id,
        sourceStage: thread.stage || 'backlog',
        projectId: thread.projectId,
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [thread.id, thread.stage, thread.projectId]);

  const StatusIcon = statusConfig[thread.status].icon;
  const statusClassName = statusConfig[thread.status].className;

  const gitStatus = statusByThread[thread.id];
  const gitConf = gitStatus ? gitSyncStateConfig[gitStatus.state] : null;
  const GitIcon = gitConf?.icon;

  return (
    <div
      ref={ref}
      className={cn(
        'group/card relative rounded-md border bg-card p-2.5 cursor-pointer transition-opacity',
        isDragging && 'opacity-40'
      )}
      onClick={() => {
        if (!isDragging) {
          navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
        }
      }}
    >
      <button
        className="absolute top-1.5 right-1.5 p-1 rounded opacity-0 group-hover/card:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(thread);
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      {projectInfo && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded inline-block mb-1"
          style={{
            backgroundColor: projectInfo.color ? `${projectInfo.color}1A` : '#3b82f61A',
            color: projectInfo.color || '#3b82f6',
          }}
        >
          {projectInfo.name}
        </span>
      )}
      <div className="text-xs font-medium mb-1.5 line-clamp-3 pr-5">{thread.title}</div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="flex items-center gap-1">
          <StatusIcon className={cn('h-3 w-3', statusClassName)} />
          <span className="text-[10px] text-muted-foreground">
            {t(`thread.status.${thread.status}`)}
          </span>
        </div>

        {gitConf && GitIcon && (
          <div className="flex items-center gap-1">
            <GitIcon className={cn('h-3 w-3', gitConf.className)} />
            <span className="text-[10px] text-muted-foreground">
              {t(gitConf.labelKey)}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-muted-foreground">
          {timeAgo(thread.completedAt || thread.createdAt, t)}
        </span>
        {thread.cost > 0 && (
          <span className="text-[10px] text-muted-foreground">
            ${thread.cost.toFixed(3)}
          </span>
        )}
      </div>
    </div>
  );
}

function KanbanColumn({ stage, threads, projectInfoById, onDelete }: { stage: ThreadStage; threads: Thread[]; projectInfoById?: Record<string, { name: string; color?: string }>; onDelete: (thread: Thread) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [isDraggedOver, setIsDraggedOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    return dropTargetForElements({
      element: el,
      getData: () => ({ type: 'kanban-column', stage }),
      canDrop: ({ source }) => source.data.type === 'kanban-card',
      onDragEnter: () => setIsDraggedOver(true),
      onDragLeave: () => setIsDraggedOver(false),
      onDrop: () => setIsDraggedOver(false),
    });
  }, [stage]);

  const StageIcon = stageConfig[stage].icon;
  const stageClassName = stageConfig[stage].className;

  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col w-80 min-w-[20rem] flex-shrink-0 rounded-lg bg-secondary/30 transition-colors',
        isDraggedOver && 'ring-2 ring-ring bg-secondary/50'
      )}
    >
      <div className="px-3 py-2.5 border-b border-border/50 flex items-center gap-2">
        <StageIcon className={cn('h-4 w-4', stageClassName)} />
        <span className="font-medium text-sm">{t(stageConfig[stage].labelKey)}</span>
        <span className="text-xs text-muted-foreground">({threads.length})</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
        {threads.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-8">
            {t('kanban.emptyColumn')}
          </div>
        ) : (
          threads.map((thread) => <KanbanCard key={thread.id} thread={thread} projectInfo={projectInfoById?.[thread.projectId]} onDelete={onDelete} />)
        )}
      </div>
    </div>
  );
}

export function KanbanView({ threads, projectId }: KanbanViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const projects = useAppStore((s) => s.projects);

  const [deleteConfirm, setDeleteConfirm] = useState<{
    threadId: string;
    projectId: string;
    title: string;
    isWorktree?: boolean;
  } | null>(null);

  const handleDeleteRequest = useCallback((thread: Thread) => {
    setDeleteConfirm({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      isWorktree: thread.mode === 'worktree' && !!thread.branch,
    });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return;
    const { threadId, projectId: threadProjectId, title } = deleteConfirm;
    const wasSelected = selectedThreadId === threadId;
    await deleteThread(threadId, threadProjectId);
    setDeleteConfirm(null);
    toast.success(t('toast.threadDeleted', { title }));
    if (wasSelected) navigate(`/projects/${threadProjectId}`);
  }, [deleteConfirm, selectedThreadId, deleteThread, navigate, t]);

  const projectInfoById = useMemo(() => {
    if (projectId) return undefined;
    const map: Record<string, { name: string; color?: string }> = {};
    for (const p of projects) map[p.id] = { name: p.name, color: p.color };
    return map;
  }, [projectId, projects]);

  const threadsByStage = useMemo(() => {
    const map: Record<ThreadStage, Thread[]> = {
      backlog: [],
      in_progress: [],
      review: [],
      done: [],
    };

    for (const thread of threads) {
      const stage = thread.stage || 'backlog';
      if (map[stage]) {
        map[stage].push(thread);
      }
    }

    // Sort each column: pinned first, then by date (most recent first)
    for (const stage of STAGES) {
      map[stage].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const dateA = a.completedAt || a.createdAt;
        const dateB = b.completedAt || b.createdAt;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      });
    }

    return map;
  }, [threads]);

  const handleDrop = useCallback(
    ({ source, location }: { source: any; location: any }) => {
      const targets = location.current.dropTargets;
      if (!targets.length) return;
      if (source.data.type !== 'kanban-card') return;

      const threadId = source.data.threadId as string;
      const sourceStage = source.data.sourceStage as ThreadStage;
      const threadProjectId = source.data.projectId as string;

      // Find the column target
      const columnTarget = targets.find(
        (t: any) => t.data.type === 'kanban-column'
      );
      if (!columnTarget) return;

      const newStage = columnTarget.data.stage as ThreadStage;
      if (newStage === sourceStage) return;

      const targetProjectId = projectId || threadProjectId;
      updateThreadStage(threadId, targetProjectId, newStage);
    },
    [projectId, updateThreadStage]
  );

  useEffect(() => {
    return monitorForElements({ onDrop: handleDrop });
  }, [handleDrop]);

  return (
    <>
      <div className="flex gap-3 h-full overflow-x-auto p-4">
        {STAGES.map((stage) => (
          <KanbanColumn key={stage} stage={stage} threads={threadsByStage[stage]} projectInfoById={projectInfoById} onDelete={handleDeleteRequest} />
        ))}
      </div>

      <Dialog
        open={!!deleteConfirm}
        onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.deleteThread')}</DialogTitle>
            <DialogDescription>
              {t('dialog.deleteThreadDesc', { title: deleteConfirm?.title })}
            </DialogDescription>
          </DialogHeader>
          {deleteConfirm?.isWorktree && (
            <p className="text-xs text-amber-500 bg-amber-500/10 rounded-md px-3 py-2">
              {t('dialog.worktreeWarning')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteConfirm}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

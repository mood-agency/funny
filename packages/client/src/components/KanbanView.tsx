import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import type { Thread, ThreadStage } from '@a-parallel/shared';
import { useThreadStore } from '@/stores/thread-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { stageConfig, statusConfig, gitSyncStateConfig, timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

interface KanbanViewProps {
  threads: Thread[];
  projectId?: string;
}

const STAGES: ThreadStage[] = ['backlog', 'in_progress', 'review', 'done'];

function KanbanCard({ thread }: { thread: Thread }) {
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
        'rounded-md border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-opacity',
        isDragging && 'opacity-40'
      )}
      onClick={() => {
        if (!isDragging) {
          navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
        }
      }}
    >
      <div className="text-xs font-medium truncate mb-1.5">{thread.title}</div>

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

function KanbanColumn({ stage, threads }: { stage: ThreadStage; threads: Thread[] }) {
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
          threads.map((thread) => <KanbanCard key={thread.id} thread={thread} />)
        )}
      </div>
    </div>
  );
}

export function KanbanView({ threads, projectId }: KanbanViewProps) {
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);

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
    <div className="flex gap-3 h-full overflow-x-auto p-4">
      {STAGES.map((stage) => (
        <KanbanColumn key={stage} stage={stage} threads={threadsByStage[stage]} />
      ))}
    </div>
  );
}

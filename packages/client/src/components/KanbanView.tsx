import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { GitStatusInfo, Thread, ThreadStage } from '@funny/shared';
import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { KanbanColumn } from '@/components/kanban/KanbanColumn';
import { SlideUpPrompt } from '@/components/SlideUpPrompt';
import { api } from '@/lib/api';
import { stageConfig } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { resolveThreadBranch } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { branchKey as computeBranchKey, useGitStatusStore } from '@/stores/git-status-store';
import { deriveToolLists, useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';

// Re-export KanbanCard for backwards-compatibility (used by other views).
export { KanbanCard } from '@/components/kanban/KanbanCard';

interface KanbanViewProps {
  threads: Thread[];
  projectId?: string;
  search?: string;
  contentSnippets?: Map<string, string>;
  highlightThreadId?: string;
}

const STAGES: ThreadStage[] = ['backlog', 'planning', 'in_progress', 'review', 'done', 'archived'];

export function KanbanView({
  threads,
  projectId,
  search,
  contentSnippets,
  highlightThreadId: initialHighlightId,
}: KanbanViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);
  const archiveThread = useThreadStore((s) => s.archiveThread);
  const unarchiveThread = useThreadStore((s) => s.unarchiveThread);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const projects = useAppStore((s) => s.projects);
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);
  const toolPermissions = useSettingsStore((s) => s.toolPermissions);

  const [deleteConfirm, setDeleteConfirm] = useState<{
    threadId: string;
    projectId: string;
    title: string;
    isWorktree?: boolean;
  } | null>(null);

  const [slideUpOpen, setSlideUpOpen] = useState(false);
  const [slideUpProjectId, setSlideUpProjectId] = useState<string | undefined>(undefined);
  const [slideUpStage, setSlideUpStage] = useState<ThreadStage>('backlog');
  const [creating, setCreating] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [mergeWarning, setMergeWarning] = useState<{
    threadId: string;
    title: string;
    sourceStage: ThreadStage;
    newStage: ThreadStage;
    gitState: string;
  } | null>(null);
  const _statusByBranch = useGitStatusStore((s) => s.statusByBranch);
  const _threadToBranchKey = useGitStatusStore((s) => s.threadToBranchKey);
  const statusByThread = useMemo(() => {
    const result: Record<string, GitStatusInfo> = {};
    for (const th of threads) {
      const bk = _threadToBranchKey[th.id] || computeBranchKey(th);
      if (_statusByBranch[bk]) result[th.id] = _statusByBranch[bk];
    }
    return result;
  }, [threads, _statusByBranch, _threadToBranchKey]);

  const [highlightThreadId, setHighlightThreadId] = useState<string | undefined>(
    initialHighlightId,
  );
  useEffect(() => {
    if (!highlightThreadId) return;
    const timer = setTimeout(() => setHighlightThreadId(undefined), 3000);
    return () => clearTimeout(timer);
  }, [highlightThreadId]);

  const handleAddThread = useCallback((threadProjectId: string, stage: ThreadStage) => {
    setSlideUpProjectId(threadProjectId);
    setSlideUpStage(stage);
    setSlideUpOpen(true);
  }, []);

  const handleDeleteRequest = useCallback((thread: Thread) => {
    setDeleteConfirm({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      isWorktree: thread.mode === 'worktree' && !!resolveThreadBranch(thread),
    });
  }, []);

  const handleArchiveRequest = useCallback(
    (thread: Thread) => {
      archiveThread(thread.id, thread.projectId);
      toast.success(t('toast.threadArchived', { title: thread.title }));
    },
    [archiveThread, t],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return;
    setDeleteLoading(true);
    const { threadId, projectId: threadProjectId, title } = deleteConfirm;
    const wasSelected = selectedThreadId === threadId;
    await deleteThread(threadId, threadProjectId);
    setDeleteLoading(false);
    setDeleteConfirm(null);
    toast.success(t('toast.threadDeleted', { title }));
    if (wasSelected) navigate(buildPath(`/projects/${threadProjectId}`));
  }, [deleteConfirm, selectedThreadId, deleteThread, navigate, t]);

  const handleMergeWarningConfirm = useCallback(() => {
    if (!mergeWarning) return;
    const { threadId, title, sourceStage, newStage } = mergeWarning;
    const targetProjectId = projectId || threads.find((th) => th.id === threadId)?.projectId;
    if (targetProjectId) {
      updateThreadStage(threadId, targetProjectId, newStage);
      const fromLabel = t(stageConfig[sourceStage].labelKey);
      const toLabel = t(stageConfig[newStage].labelKey);
      toast.success(t('toast.threadMoved', { title, from: fromLabel, to: toLabel }));
    }
    setMergeWarning(null);
  }, [mergeWarning, projectId, threads, updateThreadStage, t]);

  const handlePromptSubmit = useCallback(
    async (
      prompt: string,
      opts: {
        model: string;
        mode: string;
        threadMode?: string;
        baseBranch?: string;
        sendToBacklog?: boolean;
      },
      images?: any[],
    ): Promise<boolean> => {
      if (!slideUpProjectId || creating) return false;
      setCreating(true);

      const slideUpProject = projects.find((p) => p.id === slideUpProjectId);
      const threadMode =
        (opts.threadMode as 'local' | 'worktree') ||
        slideUpProject?.defaultMode ||
        DEFAULT_THREAD_MODE;
      const toIdle =
        opts.sendToBacklog || slideUpStage === 'backlog' || slideUpStage === 'planning';

      if (toIdle) {
        const result = await api.createIdleThread({
          projectId: slideUpProjectId,
          title: prompt.slice(0, 200),
          mode: threadMode,
          baseBranch: opts.baseBranch,
          prompt,
          stage: slideUpStage === 'planning' ? 'planning' : undefined,
          images,
        });

        if (result.isErr()) {
          toastError(result.error);
          setCreating(false);
          return false;
        }

        await loadThreadsForProject(slideUpProjectId);
        setCreating(false);
        toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
        return true;
      } else {
        const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
        const result = await api.createThread({
          projectId: slideUpProjectId,
          title: prompt.slice(0, 200),
          mode: threadMode,
          model: opts.model,
          permissionMode: opts.mode,
          baseBranch: opts.baseBranch,
          prompt,
          images,
          allowedTools,
          disallowedTools,
        });

        if (result.isErr()) {
          toastError(result.error);
          setCreating(false);
          return false;
        }

        await loadThreadsForProject(slideUpProjectId);
        setCreating(false);
        toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
        return true;
      }
    },
    [slideUpProjectId, slideUpStage, creating, projects, toolPermissions, loadThreadsForProject, t],
  );

  const projectInfoById = useMemo(() => {
    const map: Record<string, { name: string; color?: string; path?: string }> = {};
    for (const p of projects) map[p.id] = { name: p.name, color: p.color, path: p.path };
    return map;
  }, [projects]);

  const threadsByStage = useMemo(() => {
    const map: Record<ThreadStage, Thread[]> = {
      backlog: [],
      planning: [],
      in_progress: [],
      review: [],
      done: [],
      archived: [],
    };
    for (const thread of threads) {
      const stage = thread.archived ? 'archived' : thread.stage || 'backlog';
      if (map[stage]) map[stage].push(thread);
    }
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

      const columnTarget = targets.find((tt: any) => tt.data.type === 'kanban-column');
      if (!columnTarget) return;

      const newStage = columnTarget.data.stage as ThreadStage;
      if (newStage === sourceStage) return;

      const targetProjectId = projectId || threadProjectId;

      if (newStage === 'done') {
        const gitStatus = statusByThread[threadId];
        const thread = threads.find((th) => th.id === threadId);
        if (thread?.branch && gitStatus && gitStatus.state === 'dirty') {
          setMergeWarning({
            threadId,
            title: thread.title,
            sourceStage,
            newStage,
            gitState: gitStatus.state,
          });
          return;
        }
      }

      if (newStage === 'archived') {
        archiveThread(threadId, targetProjectId);
      } else if (sourceStage === 'archived') {
        unarchiveThread(threadId, targetProjectId, newStage);
      } else {
        updateThreadStage(threadId, targetProjectId, newStage);
      }

      const thread = threads.find((th) => th.id === threadId);
      const title = thread?.title || threadId;
      const fromLabel = t(stageConfig[sourceStage].labelKey);
      const toLabel = t(stageConfig[newStage].labelKey);
      toast.success(t('toast.threadMoved', { title, from: fromLabel, to: toLabel }));
    },
    [projectId, updateThreadStage, archiveThread, unarchiveThread, statusByThread, threads, t],
  );

  useEffect(() => {
    return monitorForElements({ onDrop: handleDrop });
  }, [handleDrop]);

  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    return autoScrollForElements({ element: el });
  }, []);

  return (
    <>
      <div ref={boardRef} className="flex h-full gap-3 overflow-x-auto px-4 py-2">
        {STAGES.map((stage) => (
          <KanbanColumn
            key={stage}
            stage={stage}
            threads={threadsByStage[stage]}
            projectInfoById={projectInfoById}
            onDelete={handleDeleteRequest}
            onArchive={handleArchiveRequest}
            projectId={projectId}
            projects={projects}
            onAddThread={handleAddThread}
            search={search}
            contentSnippets={contentSnippets}
            highlightThreadId={highlightThreadId}
            statusByThread={statusByThread}
          />
        ))}
      </div>

      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirm(null);
        }}
        title={t('dialog.deleteThread')}
        description={t('dialog.deleteThreadDesc', {
          title:
            deleteConfirm?.title && deleteConfirm.title.length > 80
              ? deleteConfirm.title.slice(0, 80) + '…'
              : deleteConfirm?.title,
        })}
        warning={deleteConfirm?.isWorktree ? t('dialog.worktreeWarning') : undefined}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        loading={deleteLoading}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={handleDeleteConfirm}
      />

      <ConfirmDialog
        open={!!mergeWarning}
        onOpenChange={(open) => {
          if (!open) setMergeWarning(null);
        }}
        title={t(
          `dialog.${mergeWarning?.gitState === 'unpushed' ? 'unpushedChanges' : mergeWarning?.gitState === 'dirty' ? 'dirtyChanges' : 'unmergedChanges'}`,
        )}
        description={t(
          `dialog.${mergeWarning?.gitState === 'unpushed' ? 'unpushedChangesDesc' : mergeWarning?.gitState === 'dirty' ? 'dirtyChangesDesc' : 'unmergedChangesDesc'}`,
          {
            title:
              mergeWarning?.title && mergeWarning.title.length > 80
                ? mergeWarning.title.slice(0, 80) + '…'
                : mergeWarning?.title,
          },
        )}
        variant="default"
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.continue')}
        onCancel={() => setMergeWarning(null)}
        onConfirm={handleMergeWarningConfirm}
      />

      <SlideUpPrompt
        open={slideUpOpen}
        onClose={() => setSlideUpOpen(false)}
        onSubmit={handlePromptSubmit}
        loading={creating}
        projectId={slideUpProjectId}
      />
    </>
  );
}

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { api } from '@/lib/api';
import { buildPath } from '@/lib/url';
import { resolveThreadBranch } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { type Editor } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { threadToMarkdown } from './thread-to-markdown';

/**
 * Owns the state, store reads, and async handlers for MoreActionsMenu so the
 * component file stays under the 150-line lint limit and the JSX has only
 * presentational concerns.
 */
export function useMoreActionsMenu() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const {
    threadId,
    threadProjectId,
    threadTitle,
    threadMode,
    threadBranch,
    threadPinned,
    threadWorktreePath,
    hasMessages,
    threadStatus,
  } = useThreadStore(
    useShallow((s) => ({
      threadId: s.activeThread?.id,
      threadProjectId: s.activeThread?.projectId,
      threadTitle: s.activeThread?.title,
      threadMode: s.activeThread?.mode,
      threadBranch: s.activeThread ? resolveThreadBranch(s.activeThread) : undefined,
      threadPinned: s.activeThread?.pinned,
      threadWorktreePath: s.activeThread?.worktreePath,
      hasMessages: (s.activeThread?.messages?.length ?? 0) > 0,
      threadStatus: s.activeThread?.status,
    })),
  );
  const pinThread = useThreadStore((s) => s.pinThread);
  const project = useProjectStore((s) =>
    threadProjectId ? s.projects.find((p) => p.id === threadProjectId) : undefined,
  );
  const projectBranch = useProjectStore((s) =>
    threadProjectId ? s.branchByProject[threadProjectId] : undefined,
  );
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const setTimelineVisible = useUIStore((s) => s.setTimelineVisible);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const setActivityPaneOpen = useUIStore((s) => s.setActivityPaneOpen);
  const activityActive = reviewPaneOpen && rightPaneTab === 'activity';

  const [copiedText, copyText] = useCopyToClipboard();
  const [copiedTools, copyTools] = useCopyToClipboard();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchLoading, setCreateBranchLoading] = useState(false);

  const isWorktree = threadMode === 'worktree' && !!threadBranch;
  const isBusy = threadStatus === 'running' || threadStatus === 'setting_up';
  const canConvertToWorktree = threadMode !== 'worktree' && !isBusy;
  const sourceBranch = threadBranch || projectBranch;

  const tooltipMenu = useTooltipMenu();

  const handleConvertToWorktree = useCallback(async () => {
    if (!threadId) return;
    const result = await api.convertToWorktree(threadId);
    if (result.isErr()) {
      toast.error(String(result.error));
    } else {
      toast.success(t('toast.convertToWorktreeStarted'));
    }
  }, [threadId, t]);

  const handleCreateBranch = useCallback(
    async (name: string) => {
      if (!name || !threadProjectId) return;
      setCreateBranchLoading(true);
      const result = await api.checkout(threadProjectId, name, 'carry', true, threadId);
      setCreateBranchLoading(false);
      if (result.isErr()) {
        toast.error(String(result.error));
      } else {
        setCreateBranchOpen(false);
      }
    },
    [threadProjectId, threadId],
  );

  const handleDeleteConfirm = useCallback(async () => {
    const state = useThreadStore.getState();
    const id = state.activeThread?.id;
    const projId = state.activeThread?.projectId;
    const title = state.activeThread?.title;
    if (!id || !projId) return;
    setDeleteLoading(true);
    await state.deleteThread(id, projId);
    setDeleteLoading(false);
    setDeleteOpen(false);
    toast.success(t('toast.threadDeleted', { title }));
    navigate(buildPath(`/projects/${projId}`));
  }, [navigate, t]);

  const handleCopy = useCallback(
    (includeToolCalls: boolean) => {
      const messages = useThreadStore.getState().activeThread?.messages;
      if (!messages?.length) return;
      const md = threadToMarkdown(messages, includeToolCalls);
      if (includeToolCalls) {
        copyTools(md);
      } else {
        copyText(md);
      }
    },
    [copyText, copyTools],
  );

  const handleOpenInEditor = useCallback(
    async (editor: Editor) => {
      if (!project) return;
      const folderPath = threadWorktreePath || project.path;
      const result = await api.openInEditor(folderPath, editor);
      if (result.isErr()) {
        toast.error(t('sidebar.openInEditorError', 'Failed to open in editor'));
      }
    },
    [project, threadWorktreePath, t],
  );

  const togglePin = useCallback(() => {
    if (!threadId || !threadProjectId) return;
    pinThread(threadId, threadProjectId, !threadPinned);
  }, [pinThread, threadId, threadProjectId, threadPinned]);

  const toggleActivity = useCallback(() => {
    setActivityPaneOpen(!activityActive);
  }, [activityActive, setActivityPaneOpen]);

  const toggleTimeline = useCallback(() => {
    setTimelineVisible(!timelineVisible);
  }, [timelineVisible, setTimelineVisible]);

  return {
    threadId,
    threadTitle,
    hasMessages,
    isWorktree,
    canConvertToWorktree,
    threadPinned,
    sourceBranch,
    activityActive,
    timelineVisible,
    copiedText,
    copiedTools,
    deleteOpen,
    setDeleteOpen,
    deleteLoading,
    createBranchOpen,
    setCreateBranchOpen,
    createBranchLoading,
    tooltipMenu,
    handleConvertToWorktree,
    handleCreateBranch,
    handleDeleteConfirm,
    handleCopy,
    handleOpenInEditor,
    togglePin,
    toggleActivity,
    toggleTimeline,
  };
}

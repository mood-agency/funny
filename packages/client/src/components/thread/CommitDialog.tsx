import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  GitBranch,
  GitCommit,
  Sparkles,
  FileCode,
  FilePlus,
  FileX,
  Loader2,
  Upload,
  GitPullRequest,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { FileDiff } from '@a-parallel/shared';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
};

interface FileToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

function FileToggle({ checked, onCheckedChange, disabled }: FileToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input'
      )}
    >
      <span
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0'
        )}
      />
    </button>
  );
}

interface CommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommitDialog({ open, onOpenChange }: CommitDialogProps) {
  const { t } = useTranslation();
  const activeThread = useAppStore(s => s.activeThread);
  const threadId = activeThread?.id;

  const [allFiles, setAllFiles] = useState<FileDiff[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [commitMsg, setCommitMsg] = useState('');
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<'commit' | 'commit-push' | 'commit-pr' | null>(null);

  const stagedFiles = allFiles.filter(f => f.staged);
  const hasMessage = commitMsg.trim().length > 0;
  const canCommit = includeUnstaged
    ? allFiles.length > 0 && hasMessage && !actionInProgress
    : selectedFiles.size > 0 && hasMessage && !actionInProgress;

  const refreshDiffs = async () => {
    if (!threadId) return;
    const result = await api.getDiff(threadId);
    if (result.isOk()) {
      setAllFiles(result.value);
      setSelectedFiles(new Set(result.value.map(f => f.path)));
    }
  };

  useEffect(() => {
    if (open) {
      refreshDiffs();
      setCommitMsg('');
      setActionInProgress(null);
    }
  }, [open, threadId]);

  const handleGenerateCommitMsg = async () => {
    if (!threadId || generatingMsg) return;
    setGeneratingMsg(true);
    const result = await api.generateCommitMessage(threadId);
    if (result.isOk()) {
      setCommitMsg(result.value.message);
    } else {
      toast.error(t('review.generateFailed', { message: result.error.message }));
    }
    setGeneratingMsg(false);
  };

  const performCommit = async (): Promise<boolean> => {
    if (!threadId || !hasMessage) return false;

    if (includeUnstaged) {
      // Stage all files and commit everything
      const unstaged = allFiles.filter(f => !f.staged).map(f => f.path);
      if (unstaged.length > 0) {
        const stageResult = await api.stageFiles(threadId, unstaged);
        if (stageResult.isErr()) {
          toast.error(t('review.stageFailed', { message: stageResult.error.message }));
          return false;
        }
      }

      const result = await api.commit(threadId, commitMsg);
      if (result.isErr()) {
        toast.error(t('review.commitFailed', { message: result.error.message }));
        if (unstaged.length > 0) await api.unstageFiles(threadId, unstaged);
        return false;
      }
      return true;
    }

    // Manual mode: only commit selected staged files
    const selected = Array.from(selectedFiles);
    const currentlyStaged = stagedFiles.map(f => f.path);

    const toUnstage = currentlyStaged.filter(p => !selectedFiles.has(p));
    if (toUnstage.length > 0) {
      const unstageResult = await api.unstageFiles(threadId, toUnstage);
      if (unstageResult.isErr()) {
        toast.error(t('review.unstageFailed', { message: unstageResult.error.message }));
        return false;
      }
    }

    const result = await api.commit(threadId, commitMsg);
    if (result.isErr()) {
      toast.error(t('review.commitFailed', { message: result.error.message }));
      if (toUnstage.length > 0) await api.stageFiles(threadId, toUnstage);
      return false;
    }

    if (toUnstage.length > 0) {
      await api.stageFiles(threadId, toUnstage);
    }

    return true;
  };

  const handleCommit = async () => {
    if (!canCommit) return;
    setActionInProgress('commit');
    const success = await performCommit();
    if (success) {
      toast.success(t('review.commitSuccess'));
      useGitStatusStore.getState().fetchForThread(threadId!);
      onOpenChange(false);
    }
    setActionInProgress(null);
  };

  const handleCommitAndPush = async () => {
    if (!canCommit || !threadId) return;
    setActionInProgress('commit-push');

    const commitSuccess = await performCommit();
    if (!commitSuccess) {
      setActionInProgress(null);
      return;
    }

    const pushResult = await api.push(threadId);
    if (pushResult.isErr()) {
      toast.error(t('review.pushFailed', { message: pushResult.error.message }));
      setActionInProgress(null);
      useGitStatusStore.getState().fetchForThread(threadId);
      onOpenChange(false);
      return;
    }

    toast.success(t('review.pushedSuccess'));
    useGitStatusStore.getState().fetchForThread(threadId);
    onOpenChange(false);
    setActionInProgress(null);
  };

  const handleCommitAndCreatePR = async () => {
    if (!canCommit || !threadId) return;
    setActionInProgress('commit-pr');

    const commitSuccess = await performCommit();
    if (!commitSuccess) {
      setActionInProgress(null);
      return;
    }

    const pushResult = await api.push(threadId);
    if (pushResult.isErr()) {
      toast.error(t('review.pushFailed', { message: pushResult.error.message }));
      setActionInProgress(null);
      useGitStatusStore.getState().fetchForThread(threadId);
      onOpenChange(false);
      return;
    }

    const prResult = await api.createPR(threadId, commitMsg, commitMsg);
    if (prResult.isErr()) {
      toast.error(t('review.prFailed', { message: prResult.error.message }));
      setActionInProgress(null);
      useGitStatusStore.getState().fetchForThread(threadId);
      onOpenChange(false);
      return;
    }

    if (prResult.value.url) {
      toast.success(
        <div>
          {t('review.prCreated')}
          <a href={prResult.value.url} target="_blank" rel="noopener noreferrer" className="underline ml-2">
            View PR
          </a>
        </div>
      );
    } else {
      toast.success(t('review.prCreated'));
    }

    useGitStatusStore.getState().fetchForThread(threadId);
    onOpenChange(false);
    setActionInProgress(null);
  };

  const toggleFile = (path: string) => {
    const newSelection = new Set(selectedFiles);
    if (newSelection.has(path)) {
      newSelection.delete(path);
    } else {
      newSelection.add(path);
    }
    setSelectedFiles(newSelection);
  };

  const toggleSelectAll = () => {
    if (selectedFiles.size === stagedFiles.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(stagedFiles.map(f => f.path)));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('review.commitDialogTitle', 'Commit Changes')}</DialogTitle>
          {activeThread?.branch && (
            <DialogDescription className="flex items-center gap-1.5 text-xs">
              <GitBranch className="h-3 w-3" />
              <span className="font-mono">{activeThread.branch}</span>
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          {/* Include all changes toggle */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              {t('review.includeUnstaged', 'Commit all changes')}
            </label>
            <FileToggle
              checked={includeUnstaged}
              onCheckedChange={(v) => {
                setIncludeUnstaged(v);
                if (!v) {
                  setSelectedFiles(new Set(stagedFiles.map(f => f.path)));
                }
              }}
              disabled={!!actionInProgress}
            />
          </div>

          {/* Staged files list — only when manual mode */}
          {!includeUnstaged && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('review.filesToCommit', 'Staged files')} ({selectedFiles.size}/{stagedFiles.length})
                </span>
                {stagedFiles.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleSelectAll}
                    className="h-6 text-xs"
                  >
                    {selectedFiles.size === stagedFiles.length ? t('review.deselectAll', 'Deselect All') : t('review.selectAll', 'Select All')}
                  </Button>
                )}
              </div>

              {stagedFiles.length === 0 ? (
                <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-4 text-center">
                  <p className="text-xs text-muted-foreground">
                    {t('review.stageFirst', 'No staged files. Use the Review pane to stage changes.')}
                  </p>
                </div>
              ) : (
                <ScrollArea className="max-h-48 rounded-md border border-border/60">
                  <div className="p-1">
                    {stagedFiles.map((file) => {
                      const Icon = fileStatusIcons[file.status] || FileCode;
                      const isSelected = selectedFiles.has(file.path);
                      return (
                        <div
                          key={file.path}
                          className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/50 transition-colors"
                        >
                          <FileToggle
                            checked={isSelected}
                            onCheckedChange={() => toggleFile(file.path)}
                            disabled={!!actionInProgress}
                          />
                          <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate text-xs font-mono">{file.path}</span>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}

          {/* Commit Message Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">
                {t('review.commitMessage')}
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleGenerateCommitMsg}
                    disabled={allFiles.length === 0 || generatingMsg || !!actionInProgress}
                  >
                    <Sparkles className={cn('h-3.5 w-3.5', generatingMsg && 'animate-pulse')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {generatingMsg ? t('review.generatingCommitMsg') : t('review.generateCommitMsg')}
                </TooltipContent>
              </Tooltip>
            </div>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              rows={3}
              placeholder={t('review.commitMessage')}
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              disabled={allFiles.length === 0 || !!actionInProgress}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t('review.nextStep', 'Next step')}
          </span>
          <div className="flex flex-col gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={handleCommit}
              disabled={!canCommit}
            >
              {actionInProgress === 'commit' ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <GitCommit className="h-3.5 w-3.5 mr-2" />}
              {t('review.commit', 'Commit')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={handleCommitAndPush}
              disabled={!canCommit}
            >
              {actionInProgress === 'commit-push' ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-2" />}
              {t('review.commitAndPush', 'Commit & Push')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={handleCommitAndCreatePR}
              disabled={!canCommit}
            >
              {actionInProgress === 'commit-pr' ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <GitPullRequest className="h-3.5 w-3.5 mr-2" />}
              {t('review.commitAndCreatePR', 'Commit & Create PR')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

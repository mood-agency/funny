import type { FileDiffSummary } from '@funny/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
import { gitApi } from '@/lib/api/git';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { useGitStatusStore } from '@/stores/git-status-store';

interface UseDiffDataArgs {
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  selectedFile: string | null;
  expandedFile: string | null;
  reviewPaneOpen: boolean;
  /** ReviewPane owns this state (consumed by many places); we read + write it. */
  summaries: FileDiffSummary[];
  setSummaries: Dispatch<SetStateAction<FileDiffSummary[]>>;
  /** Inner files of expanded submodules — used to resolve composite paths. */
  submoduleExpansions: Map<string, FileDiffSummary[]>;
  /** Refresh sets this to the first file when nothing is selected yet. */
  setSelectedFile: (path: string | null) => void;
  /** Refresh adds new files to the selection (keeps existing). */
  setCheckedFiles: Dispatch<SetStateAction<Set<string>>>;
}

export interface UseDiffDataResult {
  // State (owned here since these are only used through this hook's surface)
  diffCache: Map<string, string>;
  loadingDiff: string | null;
  loading: boolean;
  loadError: boolean;
  truncatedInfo: { total: number; truncated: boolean };

  // Setters (used by the parent's gitContextKey reset effect)
  setDiffCache: Dispatch<SetStateAction<Map<string, string>>>;
  setLoadError: Dispatch<SetStateAction<boolean>>;

  // Refs (passed into peer hooks like useStashState that share request lifecycle)
  abortRef: React.MutableRefObject<AbortController | null>;
  needsRefreshRef: React.MutableRefObject<boolean>;

  // Operations
  refresh: () => Promise<void>;
  loadDiffForFile: (filePath: string) => Promise<void>;
  requestFullDiff: (
    path: string,
  ) => Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null>;
}

/**
 * Owns the diff-summary + per-file diff loading lifecycle for ReviewPane.
 * Three operations: `refresh` (full summary + auto-load selected file),
 * `loadDiffForFile` (lazy single-file load on selection), and `requestFullDiff`
 * (full-context fetch for the "show full file" toggle inside ExpandedDiffView).
 *
 * Coordinates aborts through `abortRef` (also consumed by useStashState) and
 * uses an epoch counter so a stale awaited refresh can't overwrite fresh state
 * after a thread switch.
 *
 * Final piece of the ReviewPane god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function useDiffData({
  hasGitContext,
  effectiveThreadId,
  projectModeId,
  selectedFile,
  expandedFile,
  reviewPaneOpen,
  summaries,
  setSummaries,
  submoduleExpansions,
  setSelectedFile,
  setCheckedFiles,
}: UseDiffDataArgs): UseDiffDataResult {
  // Reconstruct the submodule resolver locally. Identical to the one in
  // useFileTreeState, duplicated to avoid a circular dependency: useFileTreeState
  // needs `summaries` (from this hook) while this hook needs the resolver to
  // route diff requests for inner files of expanded submodules.
  const resolveSubmoduleEntry = useCallback(
    (filePath: string): { submodulePath: string; innerPath: string; staged: boolean } | null => {
      for (const [submodulePath, inner] of submoduleExpansions) {
        const prefix = `${submodulePath}/`;
        if (!filePath.startsWith(prefix)) continue;
        const innerPath = filePath.slice(prefix.length);
        const innerSummary = inner.find((f) => f.path === innerPath);
        if (!innerSummary) continue;
        return { submodulePath, innerPath, staged: innerSummary.staged };
      }
      return null;
    },
    [submoduleExpansions],
  );

  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);
  const [truncatedInfo, setTruncatedInfo] = useState<{ total: number; truncated: boolean }>({
    total: 0,
    truncated: false,
  });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // AbortController for in-flight git requests. Aborted when the git context
  // changes (thread/project switch) to prevent piling up stale requests that
  // saturate the server's git process pool and cause progressive slowdown.
  const abortRef = useRef<AbortController | null>(null);

  // Monotonically increasing counter to detect stale refresh results. When a
  // new refresh starts, it captures the current value; if another refresh
  // starts before it finishes, the older one detects the mismatch and bails
  // out instead of overwriting state with stale data.
  const refreshEpochRef = useRef(0);

  // True while refresh() is running — used to suppress the selectedFile
  // effect from firing a duplicate diff/file load (refresh already loads it).
  const refreshingRef = useRef(false);

  // Track whether we need to refresh when the pane becomes visible.
  const needsRefreshRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!hasGitContext) return;
    refreshingRef.current = true;
    const epoch = ++refreshEpochRef.current;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const { signal } = ac;

    setLoading(true);
    setLoadError(false);

    // Fire git status refresh in parallel (don't await — it updates its own store).
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId);

    const result = effectiveThreadId
      ? await gitApi.getDiffSummary(effectiveThreadId, undefined, undefined, signal)
      : await gitApi.projectDiffSummary(projectModeId!, undefined, undefined, signal);

    if (refreshEpochRef.current !== epoch || signal.aborted) {
      refreshingRef.current = false;
      return;
    }

    if (result.isOk()) {
      const data = result.value;

      // Determine which file to load and whether it's cached BEFORE state
      // updates so we can fire the diff request in parallel with React batching.
      const newPaths = new Set(data.files.map((d) => d.path));
      const fileToLoad = selectedFile ?? (data.files.length > 0 ? data.files[0].path : null);
      const fileToLoadSummary = fileToLoad
        ? data.files.find((s) => s.path === fileToLoad)
        : undefined;

      const needsFetch =
        fileToLoad && fileToLoadSummary && !diffCache.get(fileToLoad) && !signal.aborted;

      // Start diff fetch immediately — don't wait for state updates (parallel).
      let diffPromise: Promise<void> | undefined;
      if (needsFetch) {
        setLoadingDiff(fileToLoad);
        diffPromise = (async () => {
          const diffResult = effectiveThreadId
            ? await gitApi.getFileDiff(
                effectiveThreadId,
                fileToLoad,
                fileToLoadSummary.staged,
                signal,
              )
            : await gitApi.projectFileDiff(
                projectModeId!,
                fileToLoad,
                fileToLoadSummary.staged,
                signal,
              );
          if (refreshEpochRef.current === epoch && diffResult.isOk()) {
            setDiffCache((prev) => new Map(prev).set(fileToLoad, diffResult.value.diff));
          }
          setLoadingDiff((prev) => (prev === fileToLoad ? null : prev));
        })();
      }

      setSummaries(data.files);
      setTruncatedInfo({ total: data.total, truncated: data.truncated });
      setDiffCache((prev) => {
        const next = new Map<string, string>();
        for (const [k, v] of prev) {
          if (newPaths.has(k)) next.set(k, v);
        }
        return next;
      });
      setCheckedFiles((prev) => {
        const next = new Set(prev);
        const currentPaths = new Set(data.files.map((d) => d.path));
        for (const f of data.files) {
          if (!prev.has(f.path) && prev.size === 0) {
            next.add(f.path);
          } else if (!prev.has(f.path) && data.files.length > prev.size) {
            next.add(f.path);
          }
        }
        for (const p of prev) {
          if (!currentPaths.has(p)) next.delete(p);
        }
        return next.size === 0 ? new Set(data.files.map((d) => d.path)) : next;
      });
      if (data.files.length > 0 && !selectedFile) {
        setSelectedFile(data.files[0].path);
      }

      if (diffPromise) await diffPromise;
    } else {
      if (!signal.aborted) {
        console.error('Failed to load diff summary:', result.error);
        setLoadError(true);
      }
    }
    if (!signal.aborted) setLoading(false);
    refreshingRef.current = false;
  }, [
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    selectedFile,
    diffCache,
    setSelectedFile,
    setCheckedFiles,
  ]);

  // Lazy load diff content for a specific file.
  const loadDiffForFile = useCallback(
    async (filePath: string) => {
      if (!hasGitContext || diffCache.has(filePath)) return;
      const submoduleEntry = resolveSubmoduleEntry(filePath);
      const summary = submoduleEntry ? null : summaries.find((s) => s.path === filePath);
      if (!submoduleEntry && !summary) return;
      const signal = abortRef.current?.signal;
      setLoadingDiff(filePath);
      const result = submoduleEntry
        ? effectiveThreadId
          ? await gitApi.getSubmoduleFileDiff(
              effectiveThreadId,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
            )
          : await gitApi.projectSubmoduleFileDiff(
              projectModeId!,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
            )
        : effectiveThreadId
          ? await gitApi.getFileDiff(effectiveThreadId, filePath, summary!.staged, signal)
          : await gitApi.projectFileDiff(projectModeId!, filePath, summary!.staged, signal);
      if (result.isOk() && !signal?.aborted) {
        setDiffCache((prev) => new Map(prev).set(filePath, result.value.diff));
      }
      setLoadingDiff((prev) => (prev === filePath ? null : prev));
    },
    [hasGitContext, diffCache, summaries, effectiveThreadId, projectModeId, resolveSubmoduleEntry],
  );

  // Fetch full-context diff for the "Show full file" toggle.
  const requestFullDiff = useCallback(
    async (path: string) => {
      if (!hasGitContext) return null;
      const submoduleEntry = resolveSubmoduleEntry(path);
      const summary = submoduleEntry ? null : summaries.find((s) => s.path === path);
      if (!submoduleEntry && !summary) return null;
      const signal = abortRef.current?.signal;
      const result = submoduleEntry
        ? effectiveThreadId
          ? await gitApi.getSubmoduleFileDiff(
              effectiveThreadId,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
              'full',
            )
          : await gitApi.projectSubmoduleFileDiff(
              projectModeId!,
              submoduleEntry.submodulePath,
              submoduleEntry.innerPath,
              submoduleEntry.staged,
              signal,
              'full',
            )
        : effectiveThreadId
          ? await gitApi.getFileDiff(effectiveThreadId, path, summary!.staged, signal, 'full')
          : await gitApi.projectFileDiff(projectModeId!, path, summary!.staged, signal, 'full');
      if (result.isOk() && !signal?.aborted) {
        return {
          oldValue: parseDiffOld(result.value.diff),
          newValue: parseDiffNew(result.value.diff),
          rawDiff: result.value.diff,
        };
      }
      return null;
    },
    [hasGitContext, summaries, effectiveThreadId, projectModeId, resolveSubmoduleEntry],
  );

  // Load diff when selected file changes. Skip when refresh() is running — it
  // already loads the diff for the selected file inline, so firing here would
  // cause a duplicate request.
  useEffect(() => {
    if (selectedFile && !diffCache.has(selectedFile) && !refreshingRef.current) {
      loadDiffForFile(selectedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on file selection change; diffCache/loadDiffForFile change on every refresh and would cause loops
  }, [selectedFile]);

  // Load diff when expanded file changes.
  useEffect(() => {
    if (expandedFile && !diffCache.has(expandedFile)) {
      loadDiffForFile(expandedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on expanded file change; diffCache/loadDiffForFile change on every refresh and would cause loops
  }, [expandedFile]);

  // Fire deferred refresh when the review pane becomes visible. Uses the
  // needsRefreshRef flag set by the parent's gitContextKey reset effect when
  // the pane is hidden.
  useEffect(() => {
    if (reviewPaneOpen && needsRefreshRef.current) {
      needsRefreshRef.current = false;
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh changes every render; only trigger on pane visibility change
  }, [reviewPaneOpen]);

  // Auto-refresh diffs when agent modifies files (debounced 2s).
  useAutoRefreshDiff(effectiveThreadId, refresh, 2000, reviewPaneOpen);

  return {
    diffCache,
    loadingDiff,
    loading,
    loadError,
    truncatedInfo,
    setDiffCache,
    setLoadError,
    abortRef,
    needsRefreshRef,
    refresh,
    loadDiffForFile,
    requestFullDiff,
  };
}

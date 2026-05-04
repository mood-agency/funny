import type { Thread } from '@funny/shared';
import { FolderPlus } from 'lucide-react';
import { useState, useCallback, useEffect, useRef, useMemo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Sidebar, SidebarContent, SidebarRail, useSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidebarActions } from '@/hooks/use-sidebar-actions';
import { useSidebarDragDrop } from '@/hooks/use-sidebar-drag-drop';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { IssuesDialog } from './IssuesDialog';
import { SettingsPanel } from './SettingsPanel';
import { ProjectItem } from './sidebar/ProjectItem';
import { SidebarDialogs } from './sidebar/SidebarDialogs';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarThreadsSection } from './sidebar/SidebarThreadsSection';
import { SidebarTopBar } from './sidebar/SidebarTopBar';

const EMPTY_THREADS: Thread[] = [];

export function AppSidebar({ singleProjectId }: { singleProjectId?: string | null } = {}) {
  const navigate = useStableNavigate();
  const { t } = useTranslation();
  const { toggleSidebar } = useSidebar();
  // project-store
  const allProjects = useProjectStore((s) => s.projects);
  const projects = useMemo(
    () => (singleProjectId ? allProjects.filter((p) => p.id === singleProjectId) : allProjects),
    [allProjects, singleProjectId],
  );
  const projectsInitialized = useProjectStore((s) => s.initialized);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const revealNonce = useProjectStore((s) => s.revealNonce);
  const revealIntent = useProjectStore((s) => s.revealIntent);
  const expandedProjects = useProjectStore((s) => s.expandedProjects);
  const toggleProject = useProjectStore((s) => s.toggleProject);
  const _loadProjects = useProjectStore((s) => s.loadProjects);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  // thread-store
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  // ui-store
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const startNewThread = useUIStore((s) => s.startNewThread);
  const showGlobalSearch = useUIStore((s) => s.showGlobalSearch);

  const actions = useSidebarActions();
  const {
    archiveConfirm,
    setArchiveConfirm,
    deleteThreadConfirm,
    setDeleteThreadConfirm,
    renameProjectState,
    setRenameProjectState,
    deleteProjectConfirm,
    setDeleteProjectConfirm,
    actionLoading,
    issuesProjectId,
    setIssuesProjectId,
    handleArchiveConfirm,
    handleDeleteThreadConfirm,
    handleRenameProjectConfirm,
    handleDeleteProjectConfirm,
    handleSelectThread,
    handleArchiveThread,
    handleArchiveThreadFromList,
    handleRenameThread,
    handlePinThread,
    handleDeleteThread,
    handleDeleteThreadFromList,
    handleRenameProject,
    handleDeleteProject,
    handleShowIssues,
    branchSwitchDialog,
  } = actions;

  const projectsScrollRef = useRef<HTMLDivElement>(null);
  const threadsScrollRef = useRef<HTMLDivElement>(null);
  const threadsTopSentinelRef = useRef<HTMLDivElement>(null);
  const projectsTopSentinelRef = useRef<HTMLDivElement>(null);
  const [projectsScrolled, setProjectsScrolled] = useState(false);

  // Auto-expand selected project so its threads become visible (e.g. after Ctrl+K).
  // Depends on revealNonce so re-selecting the same project also expands it.
  useEffect(() => {
    if (!selectedProjectId) return;
    if (expandedProjects.has(selectedProjectId)) return;
    toggleProject(selectedProjectId);
  }, [selectedProjectId, revealNonce, expandedProjects, toggleProject]);

  // Auto-scroll projects list to selected project (e.g. after Ctrl+K, or when
  // returning from the settings panel which unmounts the projects tree).
  // Depends on revealNonce so re-selecting the same project re-triggers the
  // scroll, and on settingsOpen so the project re-enters view after the
  // settings panel closes and the projects list re-mounts. Deferred via rAF +
  // delayed retry so scrolling happens AFTER:
  //   1. the auto-expand effect above mutates layout, and
  //   2. the command palette's close animation finishes (which can otherwise
  //      steal focus / interrupt the smooth scroll).
  useEffect(() => {
    if (settingsOpen) return;
    if (!selectedProjectId) return;
    let scrolled = false;
    const scrollToTarget = (isRetry = false): boolean => {
      if (scrolled) return true;
      const root = projectsScrollRef.current;
      if (!root) return false;

      const threadEl = selectedThreadId
        ? root.querySelector(
            `[data-project-id="${selectedProjectId}"] [data-testid="thread-item-${selectedThreadId}"]`,
          )
        : null;

      // If we are looking for a thread but it hasn't rendered yet (e.g. project is
      // currently expanding), don't fallback to the project header on the first frame.
      // This prevents a "double jump" where it centers the project header and then
      // visually jumps again when the retry finds the thread row.
      if (selectedThreadId && !threadEl && !isRetry) {
        return false;
      }

      const el =
        threadEl ??
        root.querySelector(`[data-testid="project-item-${selectedProjectId}"]`) ??
        root.querySelector(`[data-project-id="${selectedProjectId}"]`);

      if (!el) return false;

      // 'nearest' (default) avoids aggressive snapping when the row is already
      // visible (e.g. sidebar/header clicks). Ctrl+K opts into 'start' so the
      // selected project lands at the top of the projects pane, not just
      // wherever scrollIntoView decided was "nearest" (often the bottom edge
      // when scrolling down a long list).
      el.scrollIntoView({ block: revealIntent, behavior: 'smooth' });
      scrolled = true;
      return true;
    };

    // Try on the next frame. Fall back to a delayed retry only if the row
    // wasn't mounted yet (e.g. Collapsible just started expanding).
    const raf = requestAnimationFrame(() => {
      scrollToTarget(false);
    });
    // Wait longer than the transition duration so the element is fully mounted
    const timeout = window.setTimeout(() => scrollToTarget(true), 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [selectedProjectId, selectedThreadId, revealNonce, revealIntent, settingsOpen]);

  useSidebarDragDrop({ projectsScrollRef, threadsScrollRef, projects, reorderProjects });

  // Track top fade gradient on the projects scroll container via an
  // IntersectionObserver sentinel. Reacts to both scroll and content/size
  // changes (the threads section owns its own equivalent observer).
  useEffect(() => {
    const projectsRoot = projectsScrollRef.current;
    const projectsSentinel = projectsTopSentinelRef.current;
    if (!projectsRoot || !projectsSentinel) return;
    const io = new IntersectionObserver(
      () => {
        setProjectsScrolled(projectsRoot.scrollTop > 0);
      },
      { root: projectsRoot, threshold: 0 },
    );
    io.observe(projectsSentinel);
    return () => io.disconnect();
  }, []);

  // ── Stable callbacks for ProjectItem (avoids breaking memo) ──────────
  const handleToggleProject = useCallback(
    (projectId: string) => {
      toggleProject(projectId);
    },
    [toggleProject],
  );

  const handleSelectProject = useCallback(
    (projectId: string) => {
      startTransition(() => {
        useProjectStore.getState().selectProject(projectId);
        useUIStore.getState().setReviewPaneOpen(false);
        navigate(buildPath(`/projects/${projectId}`));
      });
      requestAnimationFrame(() => {
        const el = projectsScrollRef.current?.querySelector(`[data-project-id="${projectId}"]`);
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const ta = document.querySelector<HTMLElement>('[data-testid="prompt-editor"]');
        ta?.focus();
      });
    },
    [navigate],
  );

  const handleNewThread = useCallback(
    (projectId: string) => {
      startTransition(() => {
        startNewThread(projectId);
        navigate(buildPath(`/projects/${projectId}`));
      });
    },
    [startNewThread, navigate],
  );

  const handleShowAllThreads = useCallback(
    (projectId: string) => {
      showGlobalSearch();
      navigate(buildPath(`/list?project=${projectId}`));
    },
    [showGlobalSearch, navigate],
  );

  // Memoize per-project thread lists, preserving referential identity for
  // projects whose threads didn't change visually. This prevents unrelated
  // ProjectItem components from re-rendering when only non-visual thread
  // fields (cost, sessionId, etc.) were updated via WebSocket.
  const prevFilteredRef = useRef<Record<string, Thread[]>>({});
  const filteredThreadsByProject = useMemo(() => {
    const prevFiltered = prevFilteredRef.current;
    const result: Record<string, Thread[]> = {};
    for (const project of projects) {
      const src = threadsByProject[project.id];
      const filtered = (Array.isArray(src) ? src : []).filter((t) => !t.archived);
      const prev = prevFiltered[project.id];
      if (
        prev &&
        prev.length === filtered.length &&
        prev.every((prevT, i) => threadsVisuallyEqual(prevT, filtered[i]))
      ) {
        result[project.id] = prev;
      } else {
        result[project.id] = filtered;
      }
    }
    prevFilteredRef.current = result;
    return result;
  }, [threadsByProject, projects]);

  // Which projects have had their threads fetched (distinct from "fetched and
  // empty"). Used to show thread skeleton rows inside an expanded project
  // whose thread list hasn't arrived yet, instead of flashing "No threads".
  const threadsLoadedByProject = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const project of projects) {
      result[project.id] = Array.isArray(threadsByProject[project.id]);
    }
    return result;
  }, [threadsByProject, projects]);

  if (settingsOpen) {
    return <SettingsPanel />;
  }

  return (
    <Sidebar collapsible="offcanvas" className="select-none">
      <SidebarTopBar />

      <SidebarThreadsSection
        scrollRef={threadsScrollRef}
        topSentinelRef={threadsTopSentinelRef}
        onRenameThread={handleRenameThread}
        onArchiveThread={handleArchiveThreadFromList}
        onDeleteThread={handleDeleteThreadFromList}
      />

      {/* Projects header (fixed, outside scroll) */}
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('sidebar.projects')}
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              data-testid="sidebar-add-project"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => navigate(buildPath('/new'))}
            >
              <FolderPlus className="icon-sm" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('sidebar.addProject')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Projects list (fills remaining space, own scroll) */}
      <SidebarContent
        ref={projectsScrollRef}
        className="relative px-2 pb-2 contain-paint"
        onScroll={(e) => setProjectsScrolled(e.currentTarget.scrollTop > 0)}
      >
        <div ref={projectsTopSentinelRef} aria-hidden className="h-px shrink-0" />
        <div
          className={cn(
            'sticky top-0 left-0 right-0 h-8 -mt-px -mb-8 bg-gradient-to-b from-sidebar to-transparent pointer-events-none z-10 shrink-0',
            projectsScrolled ? 'opacity-100' : 'opacity-0',
          )}
        />
        {!projectsInitialized && projects.length === 0 && (
          <div
            aria-hidden
            data-testid="sidebar-projects-skeleton"
            className="flex flex-col gap-1.5"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2 py-1">
                <Skeleton className="h-3.5 w-3.5 rounded" />
                <Skeleton className="h-3.5 w-3.5 rounded" />
                <Skeleton className="h-3 flex-1" style={{ maxWidth: `${60 + ((i * 37) % 35)}%` }} />
              </div>
            ))}
          </div>
        )}
        {projectsInitialized && projects.length === 0 && (
          <button
            data-testid="sidebar-no-projects-cta"
            onClick={() => navigate(buildPath('/new'))}
            className="w-full cursor-pointer px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('sidebar.noProjects')}
          </button>
        )}
        <div className="flex flex-col gap-1.5">
          {projects.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              threads={filteredThreadsByProject[project.id] ?? EMPTY_THREADS}
              threadsLoaded={threadsLoadedByProject[project.id] ?? false}
              isExpanded={expandedProjects.has(project.id)}
              isSelected={selectedProjectId === project.id}
              onToggle={handleToggleProject}
              onSelectProject={handleSelectProject}
              onNewThread={handleNewThread}
              onRenameProject={handleRenameProject}
              onDeleteProject={handleDeleteProject}
              onSelectThread={handleSelectThread}
              onRenameThread={handleRenameThread}
              onArchiveThread={handleArchiveThread}
              onPinThread={handlePinThread}
              onDeleteThread={handleDeleteThread}
              onShowAllThreads={handleShowAllThreads}
              onShowIssues={handleShowIssues}
            />
          ))}
        </div>
      </SidebarContent>

      <SidebarFooter />

      {issuesProjectId && (
        <IssuesDialog
          projectId={issuesProjectId}
          open={!!issuesProjectId}
          onOpenChange={(open) => {
            if (!open) setIssuesProjectId(null);
          }}
          onCreateThread={(params) => {
            setIssuesProjectId(null);
            useUIStore.getState().startNewThreadFromIssue(issuesProjectId, params);
          }}
        />
      )}

      <SidebarDialogs
        archiveConfirm={archiveConfirm}
        setArchiveConfirm={setArchiveConfirm}
        handleArchiveConfirm={handleArchiveConfirm}
        deleteThreadConfirm={deleteThreadConfirm}
        setDeleteThreadConfirm={setDeleteThreadConfirm}
        handleDeleteThreadConfirm={handleDeleteThreadConfirm}
        renameProjectState={renameProjectState}
        setRenameProjectState={setRenameProjectState}
        handleRenameProjectConfirm={handleRenameProjectConfirm}
        deleteProjectConfirm={deleteProjectConfirm}
        setDeleteProjectConfirm={setDeleteProjectConfirm}
        handleDeleteProjectConfirm={handleDeleteProjectConfirm}
        actionLoading={actionLoading}
      />

      <SidebarRail />

      {branchSwitchDialog}
    </Sidebar>
  );
}

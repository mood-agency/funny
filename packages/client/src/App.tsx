import { PanelLeft } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MainContentSwitcher } from '@/components/MainContentSwitcher';
import { OverlayDialogs } from '@/components/OverlayDialogs';
import { RightPane } from '@/components/RightPane';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActiveThreadBranchSync } from '@/hooks/use-active-thread-branch-sync';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useThreadHistoryTracker } from '@/hooks/use-thread-history-tracker';
import { useWS } from '@/hooks/use-ws';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useProjectStore } from '@/stores/project-store';
import { setAppNavigate } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const AppSidebar = lazy(() =>
  import('@/components/Sidebar').then((m) => ({ default: m.AppSidebar })),
);

const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar_width';
const DEFAULT_SIDEBAR_WIDTH = 320;

/** Placeholder matching the persisted sidebar width to avoid CLS during lazy load */
function SidebarPlaceholder() {
  let w = DEFAULT_SIDEBAR_WIDTH;
  try {
    const s = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (s) w = Number(s);
  } catch {}
  return (
    <div style={{ width: w }} className="flex-shrink-0 border-r border-sidebar-border bg-sidebar" />
  );
}

/** Thin vertical strip visible when the sidebar is collapsed, click to reopen */
function CollapsedSidebarStrip() {
  const { state, toggleSidebar } = useSidebar();
  if (state === 'expanded') return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={toggleSidebar}
          className="flex h-full w-10 flex-shrink-0 cursor-pointer items-start justify-center border-r border-border bg-sidebar pt-3 transition-colors hover:bg-sidebar-accent"
          aria-label="Expand sidebar"
        >
          <PanelLeft className="icon-base text-muted-foreground" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Expand sidebar</TooltipContent>
    </Tooltip>
  );
}

const TerminalPanel = lazy(() =>
  import('@/components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadTemplates = useAgentTemplateStore((s) => s.loadTemplates);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const generalSettingsOpen = useUIStore((s) => s.generalSettingsOpen);
  const allThreadsProjectId = useUIStore((s) => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);
  const addProjectOpen = useUIStore((s) => s.addProjectOpen);
  const analyticsOpen = useUIStore((s) => s.analyticsOpen);
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const designViewDesignId = useUIStore((s) => s.designViewDesignId);
  const designViewProjectId = useUIStore((s) => s.designViewProjectId);
  const designViewOpen = !!designViewDesignId;
  const designsListProjectId = useUIStore((s) => s.designsListProjectId);
  const designsListOpen = !!designsListProjectId;
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const navigate = useNavigate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);

  // --- Right panel layout ---
  const isFullScreenView =
    settingsOpen ||
    generalSettingsOpen ||
    analyticsOpen ||
    liveColumnsOpen ||
    testRunnerOpen ||
    automationInboxOpen ||
    addProjectOpen ||
    designsListOpen ||
    designViewOpen ||
    !!allThreadsProjectId;
  const rightPaneVisible = reviewPaneOpen && !isFullScreenView;

  // Register navigate so the store can trigger navigation (e.g. from toasts)
  useEffect(() => {
    setAppNavigate(navigate);
  }, [navigate]);

  // Connect WebSocket on mount
  useWS();

  // Refresh git state when the tab/window regains focus (catches external commits)
  useRefreshOnFocus();

  // Sync URL ↔ store
  useRouteSync();

  // Keep working dir branch aligned with the active local thread (covers
  // deep-linked / new-tab loads that bypass the sidebar's preflight).
  const branchSyncDialog = useActiveThreadBranchSync();

  // Load projects and agent templates on mount (auth already initialized by AuthGate)
  useEffect(() => {
    loadProjects();
    loadTemplates();
  }, [loadProjects, loadTemplates]);

  // Update browser tab title with selected project name
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProjectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.selectedProjectId)?.name,
  );
  const selectedProjectBranch = useProjectStore((s) =>
    s.selectedProjectId ? s.branchByProject[s.selectedProjectId] : undefined,
  );
  useEffect(() => {
    if (selectedProjectName && selectedProjectBranch) {
      document.title = `${selectedProjectName} [${selectedProjectBranch}] — funny`;
    } else if (selectedProjectName) {
      document.title = `${selectedProjectName} — funny`;
    } else {
      document.title = 'funny';
    }
  }, [selectedProjectId, selectedProjectName, selectedProjectBranch]);

  // Global keyboard shortcuts (extracted to dedicated hook)
  const toggleCommandPalette = useCallback(() => {
    setCommandPaletteOpen((prev) => !prev);
  }, []);
  const toggleFileSearch = useCallback(() => {
    setFileSearchOpen((prev) => !prev);
  }, []);
  useGlobalShortcuts(toggleCommandPalette, toggleFileSearch);
  useThreadHistoryTracker();

  return (
    <SidebarProvider defaultOpen={true} className="h-screen overflow-hidden">
      <ErrorBoundary area="sidebar">
        <Suspense fallback={<SidebarPlaceholder />}>
          <AppSidebar singleProjectId={designViewOpen ? designViewProjectId : null} />
        </Suspense>
      </ErrorBoundary>
      <CollapsedSidebarStrip />

      <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="main-panel-group">
        {/* Center panel — main content + terminal */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SidebarInset className="flex h-full flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <ErrorBoundary area="main-content">
                <Suspense>
                  <MainContentSwitcher
                    generalSettingsOpen={generalSettingsOpen}
                    settingsOpen={settingsOpen}
                    analyticsOpen={analyticsOpen}
                    liveColumnsOpen={liveColumnsOpen}
                    testRunnerOpen={testRunnerOpen}
                    automationInboxOpen={automationInboxOpen}
                    addProjectOpen={addProjectOpen}
                    designViewOpen={designViewOpen}
                    designsListOpen={designsListOpen}
                    allThreadsProjectId={allThreadsProjectId}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>

            <Suspense>
              {!(
                generalSettingsOpen ||
                settingsOpen ||
                analyticsOpen ||
                liveColumnsOpen ||
                testRunnerOpen ||
                automationInboxOpen ||
                addProjectOpen ||
                designsListOpen ||
                designViewOpen
              ) && <TerminalPanel />}
            </Suspense>
          </SidebarInset>
        </div>

        <RightPane visible={rightPaneVisible} />
      </div>

      <OverlayDialogs
        branchSyncDialog={branchSyncDialog}
        commandPaletteOpen={commandPaletteOpen}
        setCommandPaletteOpen={setCommandPaletteOpen}
        fileSearchOpen={fileSearchOpen}
        setFileSearchOpen={setFileSearchOpen}
      />
    </SidebarProvider>
  );
}

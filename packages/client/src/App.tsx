import { PanelLeft } from 'lucide-react';
import { lazy, Suspense, useCallback, useState } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MainContentSwitcher } from '@/components/MainContentSwitcher';
import { OverlayDialogs } from '@/components/OverlayDialogs';
import { RightPane } from '@/components/RightPane';
import { SidebarInset, SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppShell } from '@/hooks/use-app-shell';

const AppSidebar = lazy(() =>
  import('@/components/Sidebar').then((m) => ({ default: m.AppSidebar })),
);

const TerminalPanel = lazy(() =>
  import('@/components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
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

export function App() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);

  const toggleCommandPalette = useCallback(() => setCommandPaletteOpen((prev) => !prev), []);
  const toggleFileSearch = useCallback(() => setFileSearchOpen((prev) => !prev), []);
  const shell = useAppShell({ toggleCommandPalette, toggleFileSearch });

  const fullscreenSwitcher =
    shell.generalSettingsOpen ||
    shell.settingsOpen ||
    shell.analyticsOpen ||
    shell.liveColumnsOpen ||
    shell.testRunnerOpen ||
    shell.automationInboxOpen ||
    shell.addProjectOpen ||
    shell.designsListOpen ||
    shell.designViewOpen;

  return (
    <SidebarProvider defaultOpen={true} className="h-screen overflow-hidden">
      <ErrorBoundary area="sidebar">
        <Suspense fallback={<SidebarPlaceholder />}>
          <AppSidebar singleProjectId={shell.designViewOpen ? shell.designViewProjectId : null} />
        </Suspense>
      </ErrorBoundary>
      <CollapsedSidebarStrip />

      <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="main-panel-group">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SidebarInset className="flex h-full flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <ErrorBoundary area="main-content">
                <Suspense>
                  <MainContentSwitcher
                    generalSettingsOpen={shell.generalSettingsOpen}
                    settingsOpen={shell.settingsOpen}
                    analyticsOpen={shell.analyticsOpen}
                    liveColumnsOpen={shell.liveColumnsOpen}
                    testRunnerOpen={shell.testRunnerOpen}
                    automationInboxOpen={shell.automationInboxOpen}
                    addProjectOpen={shell.addProjectOpen}
                    designViewOpen={shell.designViewOpen}
                    designsListOpen={shell.designsListOpen}
                    allThreadsProjectId={shell.allThreadsProjectId}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>

            <Suspense>{!fullscreenSwitcher && <TerminalPanel />}</Suspense>
          </SidebarInset>
        </div>

        <RightPane visible={shell.rightPaneVisible} />
      </div>

      <OverlayDialogs
        branchSyncDialog={shell.branchSyncDialog}
        commandPaletteOpen={commandPaletteOpen}
        setCommandPaletteOpen={setCommandPaletteOpen}
        fileSearchOpen={fileSearchOpen}
        setFileSearchOpen={setFileSearchOpen}
      />
    </SidebarProvider>
  );
}

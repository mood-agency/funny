import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWS } from '@/hooks/use-ws';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { setAppNavigate } from '@/stores/thread-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { AppSidebar } from '@/components/Sidebar';
import { ThreadView } from '@/components/ThreadView';
import { SidebarProvider, SidebarInset, Sidebar, SidebarContent } from '@/components/ui/sidebar';
import { Toaster } from 'sonner';
import { TOAST_DURATION } from '@/lib/utils';

// Lazy-load conditional views (bundle-conditional / bundle-dynamic-imports)
const AllThreadsView = lazy(() => import('@/components/AllThreadsView').then(m => ({ default: m.AllThreadsView })));
const ReviewPane = lazy(() => import('@/components/ReviewPane').then(m => ({ default: m.ReviewPane })));
const TerminalPanel = lazy(() => import('@/components/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const SettingsDetailView = lazy(() => import('@/components/SettingsDetailView').then(m => ({ default: m.SettingsDetailView })));
const AutomationInboxView = lazy(() => import('@/components/AutomationInboxView').then(m => ({ default: m.AutomationInboxView })));
const AddProjectView = lazy(() => import('@/components/AddProjectView').then(m => ({ default: m.AddProjectView })));
const AnalyticsView = lazy(() => import('@/components/AnalyticsView').then(m => ({ default: m.AnalyticsView })));
const CommandPalette = lazy(() => import('@/components/CommandPalette').then(m => ({ default: m.CommandPalette })));
const CircuitBreakerDialog = lazy(() => import('@/components/CircuitBreakerDialog').then(m => ({ default: m.CircuitBreakerDialog })));

export function App() {
  const loadProjects = useProjectStore(s => s.loadProjects);
  const reviewPaneOpen = useUIStore(s => s.reviewPaneOpen);
  const setReviewPaneOpen = useUIStore(s => s.setReviewPaneOpen);
  const settingsOpen = useUIStore(s => s.settingsOpen);
  const allThreadsProjectId = useUIStore(s => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore(s => s.automationInboxOpen);
  const addProjectOpen = useUIStore(s => s.addProjectOpen);
  const analyticsOpen = useUIStore(s => s.analyticsOpen);
  const navigate = useNavigate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Register navigate so the store can trigger navigation (e.g. from toasts)
  useEffect(() => { setAppNavigate(navigate); }, [navigate]);

  // Connect WebSocket on mount
  useWS();

  // Sync URL ↔ store
  useRouteSync();

  // Load projects on mount (auth already initialized by AuthGate)
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Global keyboard shortcuts
  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown })
      .__TAURI_INTERNALS__;

    const handler = (e: KeyboardEvent) => {
      // Ctrl+K for command palette (toggle)
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        setCommandPaletteOpen(prev => !prev);
        return;
      }

      // Ctrl+Shift+F for global thread search
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        e.stopPropagation();
        navigate('/search');
        return;
      }

      // Ctrl+` to toggle terminal (only in Tauri mode)
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        if (!isTauri) return; // Terminal panel only works in Tauri desktop app
        const store = useTerminalStore.getState();
        const { selectedProjectId, projects } = useProjectStore.getState();
        if (!selectedProjectId) return;
        const projectTabs = store.tabs.filter(
          (t) => t.projectId === selectedProjectId
        );
        if (projectTabs.length === 0 && !store.panelVisible) {
          const project = projects.find(
            (p: any) => p.id === selectedProjectId
          );
          const cwd = project?.path ?? 'C:\\';
          store.addTab({
            id: crypto.randomUUID(),
            label: 'Terminal 1',
            cwd,
            alive: true,
            projectId: selectedProjectId,
          });
        } else {
          store.togglePanel();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <SidebarProvider
      defaultOpen={true}
      style={
        {
          '--sidebar-width': '20rem',
        } as React.CSSProperties
      }
      className="h-screen overflow-hidden"
    >
      <AppSidebar />

      <SidebarInset className="flex flex-col overflow-hidden">
        {/* Main content + terminal */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          <Suspense>
            {settingsOpen ? <SettingsDetailView /> : analyticsOpen ? <AnalyticsView /> : automationInboxOpen ? <AutomationInboxView /> : addProjectOpen ? <AddProjectView /> : allThreadsProjectId ? <AllThreadsView /> : <ThreadView />}
          </Suspense>
        </div>

        <Suspense><TerminalPanel /></Suspense>
      </SidebarInset>

      {/* Right sidebar for review pane */}
      <SidebarProvider
        open={reviewPaneOpen && !settingsOpen}
        onOpenChange={setReviewPaneOpen}
        keyboardShortcut={false}
        style={
          {
            '--sidebar-width': '50vw',
          } as React.CSSProperties
        }
        className="!min-h-0 !w-auto"
      >
        <Sidebar side="right" collapsible="offcanvas">
          <SidebarContent className="p-0 gap-0">
            <Suspense><ReviewPane /></Suspense>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>

      <Toaster position="bottom-right" theme="dark" duration={TOAST_DURATION} />
      <Suspense><CircuitBreakerDialog /></Suspense>
      {commandPaletteOpen && <Suspense><CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} /></Suspense>}
    </SidebarProvider>
  );
}

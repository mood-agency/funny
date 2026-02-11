import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWS } from '@/hooks/use-ws';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { setAppNavigate } from '@/stores/thread-store';
import { initAuth } from '@/lib/api';
import { useTerminalStore } from '@/stores/terminal-store';
import { Sidebar } from '@/components/Sidebar';
import { ThreadView } from '@/components/ThreadView';
import { AllThreadsView } from '@/components/AllThreadsView';
import { ReviewPane } from '@/components/ReviewPane';
import { TerminalPanel } from '@/components/TerminalPanel';
import { SettingsDetailView } from '@/components/SettingsDetailView';
import { AutomationInboxView } from '@/components/AutomationInboxView';
import { AddProjectView } from '@/components/AddProjectView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from 'sonner';
import { CommandPalette } from '@/components/CommandPalette';

export function App() {
  const loadProjects = useProjectStore(s => s.loadProjects);
  const reviewPaneOpen = useUIStore(s => s.reviewPaneOpen);
  const settingsOpen = useUIStore(s => s.settingsOpen);
  const allThreadsProjectId = useUIStore(s => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore(s => s.automationInboxOpen);
  const addProjectOpen = useUIStore(s => s.addProjectOpen);
  const navigate = useNavigate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Register navigate so the store can trigger navigation (e.g. from toasts)
  useEffect(() => { setAppNavigate(navigate); }, [navigate]);

  // Connect WebSocket on mount
  useWS();

  // Sync URL ↔ store
  useRouteSync();

  // Fetch auth token, then load projects
  useEffect(() => {
    initAuth().then(() => loadProjects());
  }, [loadProjects]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+K for command palette
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }

      // Ctrl+` to toggle terminal
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
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
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 flex-shrink-0 border-r border-border flex flex-col">
          <Sidebar />
        </aside>

        {/* Main content + terminal */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex overflow-hidden min-h-0">
            {settingsOpen ? <SettingsDetailView /> : automationInboxOpen ? <AutomationInboxView /> : addProjectOpen ? <AddProjectView /> : allThreadsProjectId ? <AllThreadsView /> : <ThreadView />}
          </div>
          <TerminalPanel />
        </main>

        {/* Review pane */}
        {reviewPaneOpen && !settingsOpen && (
          <aside className="w-[clamp(420px,40vw,960px)] flex-shrink-0 border-l border-border overflow-hidden">
            <ReviewPane />
          </aside>
        )}
      </div>

      <Toaster position="bottom-right" theme="dark" />
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
    </TooltipProvider>
  );
}

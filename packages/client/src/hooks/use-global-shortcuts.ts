import { startTransition, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

export function useGlobalShortcuts(
  onToggleCommandPalette: () => void,
  onToggleFileSearch: () => void,
) {
  const navigate = useNavigate();

  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

    const handler = (e: KeyboardEvent) => {
      // Ctrl+K for command palette (toggle)
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        startTransition(() => {
          onToggleCommandPalette();
        });
        return;
      }

      // Ctrl+P for file search (toggle)
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        startTransition(() => {
          onToggleFileSearch();
        });
        return;
      }

      // Ctrl+Shift+F for thread search — scope to current thread's project by default
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        e.stopPropagation();
        const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
        const projectId = activeThreadProjectId ?? useProjectStore.getState().selectedProjectId;
        navigate(buildPath(projectId ? `/list?project=${projectId}` : '/list'));
        return;
      }

      // Ctrl+` to toggle terminal (only in Tauri mode)
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        if (!isTauri) return;
        const store = useTerminalStore.getState();
        const { selectedProjectId, projects } = useProjectStore.getState();
        if (!selectedProjectId) return;
        const projectTabs = store.tabs.filter((t) => t.projectId === selectedProjectId);
        const isVisible = store.panelVisibleByProject[selectedProjectId] ?? false;
        if (projectTabs.length === 0 && !isVisible) {
          const project = projects.find((p: any) => p.id === selectedProjectId);
          const cwd = project?.path ?? 'C:\\';
          store.addTab({
            id: crypto.randomUUID(),
            label: 'Terminal 1',
            cwd,
            alive: true,
            projectId: selectedProjectId,
          });
        } else {
          store.togglePanel(selectedProjectId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, onToggleCommandPalette, onToggleFileSearch]);
}

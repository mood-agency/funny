import { FolderOpen } from 'lucide-react';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { settingsItems, settingsLabelKeys } from '@/components/SettingsPanel';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
  CommandItem,
} from '@/components/ui/command';
import { buildPath } from '@/lib/url';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projects = useProjectStore((s) => s.projects);
  const startNewThread = useUIStore((s) => s.startNewThread);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const navigatedRef = useRef(false);

  const handleProjectSelect = (projectId: string) => {
    navigatedRef.current = true;
    onOpenChange(false);
    startNewThread(projectId);
    useGitStatusStore.getState().fetchForProject(projectId);
    navigate(buildPath(`/projects/${projectId}`));
  };

  // Prevent Radix from restoring focus to the previously-focused element
  // after a navigation action (project/settings select). Instead, manually
  // focus the prompt editor once it has been mounted by React + TipTap.
  //
  // Radix Dialog has two focus-restoration paths:
  //   1. onCloseAutoFocus — we prevent the default here
  //   2. FocusScope cleanup on unmount — runs after onCloseAutoFocus
  // A single rAF isn't enough because the FocusScope cleanup steals
  // focus back after our initial focus call. We schedule multiple
  // attempts so the last one wins after all Radix teardown is complete.
  const handleCloseAutoFocus = useCallback((e: Event) => {
    if (navigatedRef.current) {
      e.preventDefault();
      navigatedRef.current = false;

      const focusEditor = () => {
        const editor = document.querySelector<HTMLElement>('[data-testid="prompt-editor"]');
        editor?.focus();
      };

      // Immediate attempt (for fast renders)
      requestAnimationFrame(focusEditor);
      // Delayed attempt to beat FocusScope cleanup + animation teardown
      setTimeout(focusEditor, 50);
      setTimeout(focusEditor, 150);
    }
  }, []);

  const handleSettingsSelect = (itemId: string) => {
    navigatedRef.current = true;
    onOpenChange(false);
    setSettingsOpen(true);
    navigate(buildPath(`/settings/${itemId}`));
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} onCloseAutoFocus={handleCloseAutoFocus}>
      <CommandInput
        data-testid="command-palette-search"
        placeholder={t('commandPalette.searchPlaceholder')}
      />
      <CommandList>
        <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>
        <CommandGroup heading={t('commandPalette.projects')}>
          {projects.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t('commandPalette.noProjects')}
            </div>
          ) : (
            projects.map((project) => (
              <CommandItem
                key={project.id}
                data-testid={`command-palette-project-${project.id}`}
                value={`${project.name} ${project.path}`}
                onSelect={() => handleProjectSelect(project.id)}
              >
                <FolderOpen className="icon-base flex-shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{project.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{project.path}</span>
                </div>
              </CommandItem>
            ))
          )}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('commandPalette.settings')}>
          {settingsItems.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.id}
                data-testid={`command-palette-settings-${item.id}`}
                value={item.label}
                onSelect={() => handleSettingsSelect(item.id)}
              >
                <Icon className="icon-base" />
                <span>{t(settingsLabelKeys[item.id] ?? item.label)}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

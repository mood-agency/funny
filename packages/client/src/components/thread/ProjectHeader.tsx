import { memo } from 'react';

import { useProjectStore } from '@/stores/project-store';

import { HeaderLeftSection } from './header/HeaderLeftSection';
import { HeaderRightActions } from './header/HeaderRightActions';

/**
 * Top bar of the active thread view: kanban/parent back buttons, project +
 * thread title breadcrumb, Linear quick link (left side); stage badge,
 * startup commands, terminal/test/files/diff toggles, and the more-actions
 * dropdown (right side).
 *
 * Now a thin orchestrator — the heavy lifting lives in HeaderLeftSection and
 * HeaderRightActions in `./header/`.
 */
export const ProjectHeader = memo(function ProjectHeader() {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  if (!selectedProjectId) return null;
  return (
    <div className="h-12 border-b border-border px-4 py-2">
      <div className="flex items-center justify-between">
        <HeaderLeftSection />
        <HeaderRightActions />
      </div>
    </div>
  );
});

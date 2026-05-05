import type { Project } from '@funny/shared';

import { SetupProjectDialog } from '@/components/SetupProjectDialog';

interface Props {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Conditionally renders SetupProjectDialog when the project needs setup.
 * Pulled out of ProjectItem so the parent doesn't import SetupProjectDialog
 * directly (drops 1 fan-out edge).
 */
export function ProjectSetupHost({ project, open, onOpenChange }: Props) {
  if (!project.needsSetup) return null;
  return (
    <SetupProjectDialog
      projectId={project.id}
      projectName={project.name}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

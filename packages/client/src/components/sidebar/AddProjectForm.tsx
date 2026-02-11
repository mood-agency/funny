import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Plus } from 'lucide-react';
import { useAppStore } from '@/stores/app-store';

export function AddProjectForm() {
  const { t } = useTranslation();
  const setAddProjectOpen = useAppStore(s => s.setAddProjectOpen);
  const projects = useAppStore(s => s.projects);

  return (
    <div className="px-2 pt-2 pb-1">
      <div className="group/projects flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('sidebar.projects')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setAddProjectOpen(true)}
              className="text-muted-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('sidebar.addProject')}</TooltipContent>
        </Tooltip>
      </div>
      {projects.length === 0 && (
        <button
          onClick={() => setAddProjectOpen(true)}
          className="w-full text-left px-2 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {t('sidebar.noProjects')}
        </button>
      )}
    </div>
  );
}

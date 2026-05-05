import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FolderPicker } from '@/components/FolderPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';

interface Props {
  projectId: string;
  currentPath: string;
  onSave: (projectId: string, data: { path: string }) => Promise<void>;
}

/**
 * Editable text input + folder picker for the project's filesystem path.
 * Extracted from GeneralSettings so the parent doesn't import FolderPicker
 * or the FolderOpen icon.
 */
export function ProjectPathSetting({ projectId, currentPath, onSave }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(currentPath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(currentPath);
  }, [currentPath]);

  const dirty = value.trim() !== currentPath && value.trim().length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(projectId, { path: value.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border/50 px-4 py-3.5 last:border-b-0">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t('settings.projectPath', 'Project Path')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'settings.projectPathDesc',
              'Absolute path to the git repository. Existing threads keep their original worktrees; new threads will use the updated path.',
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            data-testid="settings-project-path"
            className="flex-1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="/absolute/path/to/repo"
          />
          <TooltipIconButton
            data-testid="settings-project-path-browse"
            variant="outline"
            size="icon"
            onClick={() => setPickerOpen(true)}
            tooltip={t('sidebar.browseFolder', 'Browse folder')}
            aria-label={t('sidebar.browseFolder', 'Browse folder')}
          >
            <FolderOpen className="icon-base" />
          </TooltipIconButton>
          <Button
            data-testid="settings-project-path-save"
            size="sm"
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? t('common.loading', 'Saving…') : t('common.save', 'Save')}
          </Button>
        </div>
      </div>
      {pickerOpen && (
        <FolderPicker
          onSelect={(p) => {
            setValue(p);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

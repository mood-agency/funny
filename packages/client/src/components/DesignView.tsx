import type { Design } from '@funny/shared';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('design-view');

export function DesignView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projectId = useUIStore((s) => s.designViewProjectId);
  const designId = useUIStore((s) => s.designViewDesignId);

  const [design, setDesign] = useState<Design | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!designId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await api.getDesign(designId);
      if (cancelled) return;
      if (res.isErr()) {
        log.error('getDesign failed', { designId, error: res.error });
        setError(res.error.friendlyMessage ?? res.error.message ?? 'Failed to load design');
        setLoading(false);
        return;
      }
      setDesign(res.value);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [designId]);

  const goBack = () => {
    if (projectId) {
      navigate(buildPath(`/projects/${projectId}`));
    } else {
      navigate(buildPath('/'));
    }
  };

  return (
    <div className="flex h-full w-full flex-col" data-testid="design-view">
      <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-background px-4">
        <Button
          data-testid="design-view-back"
          variant="ghost"
          size="sm"
          onClick={goBack}
          aria-label={t('common.back', { defaultValue: 'Back' })}
        >
          <ArrowLeft className="icon-base" />
        </Button>
        <Sparkles className="icon-base text-muted-foreground" />
        <h1 className="text-sm font-semibold">
          {design?.name ?? t('designView.loading', { defaultValue: 'Loading design…' })}
        </h1>
        {design && (
          <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t(`designView.types.${design.type}`, { defaultValue: design.type })}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : error ? (
          <p
            data-testid="design-view-error"
            className="rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error"
          >
            {error}
          </p>
        ) : design ? (
          <div className="mx-auto max-w-4xl space-y-4">
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="text-lg font-semibold">{design.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('designView.folder', { defaultValue: 'Folder' })}: {design.folderPath}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('designView.placeholder', {
                defaultValue: 'Design canvas coming soon.',
              })}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

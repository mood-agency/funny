import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CheckCircle2, XCircle, Clock, AlertTriangle, Play } from 'lucide-react';

function formatDuration(ms: number, t: (key: string, opts?: any) => string): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('duration.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return t('duration.minutesSeconds', { minutes, seconds: remainingSeconds });
}

export function AgentResultCard({ status, cost, duration }: { status: 'completed' | 'failed'; cost: number; duration: number }) {
  const { t } = useTranslation();
  const isSuccess = status === 'completed';

  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 text-xs flex items-center gap-3',
      isSuccess
        ? 'border-green-500/30 bg-green-500/5'
        : 'border-red-500/30 bg-red-500/5'
    )}>
      {isSuccess ? (
        <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
      )}
      <span className={cn('font-medium', isSuccess ? 'text-green-500' : 'text-red-500')}>
        {isSuccess ? t('thread.taskCompleted') : t('thread.taskFailed')}
      </span>
      <div className="flex items-center gap-3 ml-auto text-muted-foreground">
        {duration > 0 && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(duration, t)}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentInterruptedCard({ onContinue }: { onContinue?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-xs flex items-center gap-3">
      <AlertTriangle className="h-4 w-4 text-orange-400 flex-shrink-0" />
      <div>
        <span className="font-medium text-orange-400">{t('thread.taskInterrupted')}</span>
        <p className="text-muted-foreground mt-0.5">
          {t('thread.serverRestarted')}
        </p>
      </div>
      {onContinue && (
        <button
          onClick={onContinue}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Play className="h-3 w-3" />
          {t('thread.acceptContinue')}
        </button>
      )}
    </div>
  );
}

export function AgentStoppedCard({ onContinue }: { onContinue?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs flex items-center gap-3">
      <XCircle className="h-4 w-4 text-blue-400 flex-shrink-0" />
      <div>
        <span className="font-medium text-blue-400">{t('thread.taskStopped')}</span>
        <p className="text-muted-foreground mt-0.5">
          {t('thread.manuallyStopped')}
        </p>
      </div>
      {onContinue && (
        <button
          onClick={onContinue}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Play className="h-3 w-3" />
          {t('thread.acceptContinue')}
        </button>
      )}
    </div>
  );
}

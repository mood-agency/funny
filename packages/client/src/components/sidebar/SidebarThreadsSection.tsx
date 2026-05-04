import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { ThreadList } from './ThreadList';

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>;
  topSentinelRef: RefObject<HTMLDivElement | null>;
  onRenameThread: (projectId: string, threadId: string, newTitle: string) => void;
  onArchiveThread: (
    threadId: string,
    projectId: string,
    title: string,
    isWorktree: boolean,
  ) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

/**
 * The "Threads" pane at the top of AppSidebar — own scroll area with a sticky
 * top fade gradient that reflects scroll state via an IntersectionObserver
 * sentinel. Extracted to drop ScrollArea/ThreadList from Sidebar.tsx's
 * fan-out.
 */
export function SidebarThreadsSection({
  scrollRef,
  topSentinelRef,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
}: Props) {
  const { t } = useTranslation();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      () => {
        setScrolled(root.scrollTop > 0);
      },
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRef, topSentinelRef]);

  return (
    <div className="flex max-h-[40%] min-h-[5rem] shrink-0 flex-col contain-paint">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('sidebar.threadsTitle')}
        </h2>
      </div>
      <ScrollArea
        viewportRef={scrollRef}
        viewportProps={{
          onScroll: (e) => setScrolled((e.currentTarget as HTMLDivElement).scrollTop > 0),
        }}
        className="relative min-h-0 px-2 pb-2"
      >
        <div ref={topSentinelRef} aria-hidden className="h-px shrink-0" />
        <div
          className={cn(
            'sticky top-0 left-0 right-0 h-8 -mt-px -mb-8 bg-gradient-to-b from-sidebar to-transparent pointer-events-none z-10',
            scrolled ? 'opacity-100' : 'opacity-0',
          )}
        />
        <ThreadList
          onRenameThread={onRenameThread}
          onArchiveThread={onArchiveThread}
          onDeleteThread={onDeleteThread}
        />
      </ScrollArea>
    </div>
  );
}

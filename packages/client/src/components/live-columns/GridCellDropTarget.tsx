import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  cellIndex: number;
  children: ReactNode;
}

/**
 * Drop-target wrapper for a grid cell — highlights when a sidebar thread is
 * dragged over it. Extracted from LiveColumnsView so the parent doesn't
 * import dropTargetForElements directly.
 */
export const GridCellDropTarget = memo(function GridCellDropTarget({ cellIndex, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ type: 'grid-cell', cellIndex }),
      canDrop: ({ source }) => source.data.type === 'grid-thread',
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [cellIndex]);

  return (
    <div
      ref={ref}
      className={cn('flex min-h-0 flex-1 flex-col', isOver && 'rounded-sm ring-2 ring-primary')}
      data-testid={`grid-drop-target-${cellIndex}`}
    >
      {children}
    </div>
  );
});

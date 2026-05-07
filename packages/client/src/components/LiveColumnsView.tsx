import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { LayoutGrid, Loader2, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ImageLightbox } from '@/components/ImageLightbox';
import { EmptyGridCell } from '@/components/live-columns/EmptyGridCell';
import { MAX_GRID_COLS, MAX_GRID_ROWS } from '@/components/live-columns/grid-constants';
import { GridCellDropTarget } from '@/components/live-columns/GridCellDropTarget';
import { GridColumnInsertDropTarget } from '@/components/live-columns/GridColumnInsertDropTarget';
import { GridPicker } from '@/components/live-columns/GridPicker';
import { ProjectPickerPopover } from '@/components/live-columns/ProjectPickerPopover';
import { ThreadColumn } from '@/components/live-columns/ThreadColumn';
import { Button } from '@/components/ui/button';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { createClientLogger } from '@/lib/client-logger';
import { getGridCells, type GridCellAssignments } from '@/lib/grid-storage';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { createDraftThread } from './live-columns/draft-thread';

const log = createClientLogger('LiveColumnsView');

type OpenLightboxFn = (images: { src: string; alt: string }[], index: number) => void;

export function LiveColumnsView() {
  const { t } = useTranslation();
  useMinuteTick();
  const projects = useProjectStore((s) => s.projects);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const [gridCols, setGridCols] = useState(() => {
    const saved = localStorage.getItem('funny:grid-cols');
    return saved ? Math.min(Math.max(Number(saved), 1), MAX_GRID_COLS) : 2;
  });
  const [gridRows, setGridRows] = useState(() => {
    const saved = localStorage.getItem('funny:grid-rows');
    return saved ? Math.min(Math.max(Number(saved), 1), MAX_GRID_ROWS) : 2;
  });

  // Load threads once for any project that hasn't been loaded yet (no polling —
  // WS events keep the store in sync after the initial load).
  const projectIdsKey = useMemo(() => projects.map((p) => p.id).join(','), [projects]);
  useEffect(() => {
    const state = useThreadStore.getState();
    for (const project of projects) {
      if (!state.threadsByProject[project.id]) {
        loadThreadsForProject(project.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdsKey]);

  // --- Image lightbox (shared across all columns) ---
  const [lightboxImages, setLightboxImages] = useState<{ src: string; alt: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const openLightbox = useCallback<OpenLightboxFn>((images, index) => {
    setLightboxImages(images);
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  const [gridCells, setGridCells] = useState<GridCellAssignments>(getGridCells);

  const assignThreadToCell = useCallback((cellIndex: number, threadId: string) => {
    setGridCells((prev) => {
      const updated = { ...prev };
      for (const [key, val] of Object.entries(updated)) {
        if (val === threadId) delete updated[key];
      }
      updated[String(cellIndex)] = threadId;
      localStorage.setItem('funny:grid-cells', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const handleRemoveFromGrid = useCallback(
    (cellIndex: number) => {
      setGridCells((prev) => {
        const updated = { ...prev };
        delete updated[String(cellIndex)];

        const col = cellIndex % gridCols;

        if (gridCols <= 1) {
          localStorage.setItem('funny:grid-cells', JSON.stringify(updated));
          return updated;
        }

        const columnEmpty = Array.from({ length: gridRows }).every((_, r) => {
          const idx = r * gridCols + col;
          return !updated[String(idx)];
        });

        if (!columnEmpty) {
          localStorage.setItem('funny:grid-cells', JSON.stringify(updated));
          return updated;
        }

        const newCols = gridCols - 1;
        const collapsed: GridCellAssignments = {};
        for (const [key, val] of Object.entries(updated)) {
          const oldIdx = Number(key);
          const oldCol = oldIdx % gridCols;
          const oldRow = Math.floor(oldIdx / gridCols);
          if (oldCol === col) continue;
          const newCol = oldCol > col ? oldCol - 1 : oldCol;
          collapsed[String(oldRow * newCols + newCol)] = val;
        }
        setGridCols(newCols);
        localStorage.setItem('funny:grid-cols', String(newCols));
        localStorage.setItem('funny:grid-cells', JSON.stringify(collapsed));
        return collapsed;
      });
    },
    [gridCols, gridRows],
  );

  // Header "+" flow: pick a project, then a draft thread is created automatically
  // and placed in a brand-new column appended at the right of the grid.
  const [headerCreating, setHeaderCreating] = useState(false);
  const handleAddColumnWithProject = useCallback(
    async (pid: string) => {
      if (headerCreating) return;
      if (gridCols >= MAX_GRID_COLS) {
        toast.info(t('live.gridFull', 'Grid is full'));
        return;
      }
      setHeaderCreating(true);
      const project = projects.find((p) => p.id === pid);
      const threadId = await createDraftThread(pid, project?.defaultMode);
      if (!threadId) {
        setHeaderCreating(false);
        return;
      }
      log.info({ projectId: pid, threadId }, 'header new draft thread created');
      await loadThreadsForProject(pid);

      const oldCols = gridCols;
      const newCols = oldCols + 1;
      const insertIndex = oldCols;
      setGridCells((prev) => {
        const updated: GridCellAssignments = {};
        for (const [key, val] of Object.entries(prev)) {
          if (val === threadId) continue;
          const oldIdx = Number(key);
          const oldCol = oldIdx % oldCols;
          const oldRow = Math.floor(oldIdx / oldCols);
          updated[String(oldRow * newCols + oldCol)] = val;
        }
        updated[String(insertIndex)] = threadId;
        localStorage.setItem('funny:grid-cells', JSON.stringify(updated));
        return updated;
      });
      setGridCols(newCols);
      localStorage.setItem('funny:grid-cols', String(newCols));
      setHeaderCreating(false);
    },
    [headerCreating, gridCols, projects, loadThreadsForProject, t],
  );

  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    return monitorForElements({
      onDragStart: ({ source }) => {
        if (source.data.type === 'grid-thread') setIsDragging(true);
      },
      onDrop: ({ source, location }) => {
        setIsDragging(false);
        if (source.data.type !== 'grid-thread') return;
        const targets = location.current.dropTargets;
        if (!targets.length) return;

        const targetData = targets[0].data;
        const threadId = source.data.threadId as string;

        if (targetData.type === 'grid-cell') {
          const cellIndex = targetData.cellIndex as number;
          setGridCells((prev) => {
            const updated = { ...prev };

            // Find the source cell index if it was already in the grid
            let sourceKey: string | undefined;
            for (const [key, val] of Object.entries(updated)) {
              if (val === threadId) {
                sourceKey = key;
                delete updated[key];
              }
            }

            // If the target cell already has a thread, and we are dragging from within the grid,
            // swap them. Otherwise, just overwrite/place.
            const existingThreadId = updated[String(cellIndex)];
            if (existingThreadId && sourceKey) {
              updated[sourceKey] = existingThreadId;
            }

            updated[String(cellIndex)] = threadId;
            localStorage.setItem('funny:grid-cells', JSON.stringify(updated));
            return updated;
          });
          return;
        }

        if (targetData.type === 'grid-col-insert') {
          const insertIndex = targetData.insertIndex as number;
          if (gridCols >= MAX_GRID_COLS) {
            toast.info(t('live.gridFull', 'Grid is full'));
            return;
          }
          const oldCols = gridCols;
          const newCols = oldCols + 1;
          setGridCells((prev) => {
            const updated: GridCellAssignments = {};
            for (const [key, val] of Object.entries(prev)) {
              if (val === threadId) continue;
              const oldIdx = Number(key);
              const oldCol = oldIdx % oldCols;
              const oldRow = Math.floor(oldIdx / oldCols);
              const newCol = oldCol < insertIndex ? oldCol : oldCol + 1;
              const newIdx = oldRow * newCols + newCol;
              updated[String(newIdx)] = val;
            }
            updated[String(insertIndex)] = threadId;
            localStorage.setItem('funny:grid-cells', JSON.stringify(updated));
            return updated;
          });
          setGridCols(newCols);
          localStorage.setItem('funny:grid-cols', String(newCols));
        }
      },
    });
  }, [gridCols, t]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid="grid-view">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <LayoutGrid className="icon-sm text-muted-foreground" /> {t('live.title', 'Grid')}
        </span>
        <ProjectPickerPopover
          placeholder={t('kanban.searchProject', 'Search project...')}
          onSelect={handleAddColumnWithProject}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              data-testid="grid-new-thread"
              disabled={gridCols >= MAX_GRID_COLS || headerCreating}
            >
              {headerCreating ? (
                <Loader2 className="icon-base animate-spin" />
              ) : (
                <Plus className="icon-base" />
              )}
            </Button>
          }
        />

        <div className="ml-auto">
          <GridPicker
            cols={gridCols}
            rows={gridRows}
            onChange={(c, r) => {
              setGridCols(c);
              setGridRows(r);
              localStorage.setItem('funny:grid-cols', String(c));
              localStorage.setItem('funny:grid-rows', String(r));
            }}
          />
        </div>
      </div>

      <div
        data-testid="grid-container"
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-2"
      >
        <div className="flex h-full">
          <GridColumnInsertDropTarget
            insertIndex={0}
            isDragging={isDragging}
            disabled={gridCols >= MAX_GRID_COLS}
          />
          {Array.from({ length: gridCols }).flatMap((_, c) => [
            <div
              key={`col-${c}`}
              className="flex h-full min-w-[280px] flex-1 flex-col gap-2"
              data-testid={`grid-col-${c}`}
            >
              {Array.from({ length: gridRows }, (_, r) => {
                const cellIndex = r * gridCols + c;
                const threadId = gridCells[String(cellIndex)];
                return (
                  <GridCellDropTarget
                    key={threadId ? `col-${threadId}` : `empty-${cellIndex}`}
                    cellIndex={cellIndex}
                  >
                    {threadId ? (
                      <ThreadColumn
                        threadId={threadId}
                        onRemove={() => handleRemoveFromGrid(cellIndex)}
                        onOpenLightbox={openLightbox}
                      />
                    ) : (
                      <EmptyGridCell
                        cellIndex={cellIndex}
                        onCreated={(newThreadId) => assignThreadToCell(cellIndex, newThreadId)}
                      />
                    )}
                  </GridCellDropTarget>
                );
              })}
            </div>,
            <GridColumnInsertDropTarget
              key={`insert-${c + 1}`}
              insertIndex={c + 1}
              isDragging={isDragging}
              disabled={gridCols >= MAX_GRID_COLS}
            />,
          ])}
        </div>
      </div>

      <ImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}

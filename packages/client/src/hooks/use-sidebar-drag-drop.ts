import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Project } from '@funny/shared';
import { useEffect, type RefObject } from 'react';

interface Options {
  projectsScrollRef: RefObject<HTMLDivElement | null>;
  threadsScrollRef: RefObject<HTMLDivElement | null>;
  projects: Project[];
  reorderProjects: (ids: string[]) => void;
}

/**
 * Sidebar drag-and-drop wiring: auto-scrolls the projects/threads scroll
 * containers while dragging near their edges, and reorders projects on drop.
 *
 * Extracted from Sidebar.tsx so the parent doesn't need to import the
 * atlaskit packages directly (drops 2 fan-out edges).
 */
export function useSidebarDragDrop({
  projectsScrollRef,
  threadsScrollRef,
  projects,
  reorderProjects,
}: Options) {
  useEffect(() => {
    const projectsEl = projectsScrollRef.current;
    const threadsEl = threadsScrollRef.current;
    const cleanups: Array<() => void> = [];
    if (projectsEl) {
      cleanups.push(
        autoScrollForElements({
          element: projectsEl,
          canScroll: ({ source }) => source.data.type === 'sidebar-project',
        }),
      );
    }
    if (threadsEl) {
      cleanups.push(
        autoScrollForElements({
          element: threadsEl,
          canScroll: ({ source }) => source.data.type === 'grid-thread',
        }),
      );
    }
    return () => {
      for (const c of cleanups) c();
    };
  }, [projectsScrollRef, threadsScrollRef]);

  useEffect(() => {
    return monitorForElements({
      onDrop: ({ source, location }) => {
        const targets = location.current.dropTargets;
        if (!targets.length) return;
        if (source.data.type !== 'sidebar-project') return;

        const targetData = targets[0].data;
        if (targetData.type !== 'sidebar-project') return;

        const sourceId = source.data.projectId as string;
        const targetId = targetData.projectId as string;
        if (sourceId === targetId) return;

        const oldIndex = projects.findIndex((p) => p.id === sourceId);
        const newIndex = projects.findIndex((p) => p.id === targetId);
        if (oldIndex === -1 || newIndex === -1) return;

        const reordered = [...projects];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        reorderProjects(reordered.map((p) => p.id));
      },
    });
  }, [projects, reorderProjects]);
}

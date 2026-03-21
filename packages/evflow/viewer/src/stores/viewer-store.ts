import { create } from 'zustand';

import type { EventModelData, ElementKind } from '../../../src/types';

interface ViewerState {
  /** Raw model data loaded from JSON */
  model: EventModelData | null;
  /** Currently selected node id */
  selectedNode: string | null;
  /** Currently selected edge id */
  selectedEdge: string | null;
  /** Active slice filter (null = show all) */
  activeSlice: string | null;
  /** Active kind filter (null = show all) */
  activeKind: ElementKind | null;
  /** Search query for filtering nodes */
  searchQuery: string;
  /** Active tab */
  activeTab: 'graph' | 'elements' | 'sequences';

  // Actions
  setModel: (model: EventModelData) => void;
  setSelectedNode: (id: string | null) => void;
  setSelectedEdge: (id: string | null) => void;
  setActiveSlice: (slice: string | null) => void;
  setActiveKind: (kind: ElementKind | null) => void;
  setSearchQuery: (query: string) => void;
  setActiveTab: (tab: 'graph' | 'elements' | 'sequences') => void;
  reset: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  model: null,
  selectedNode: null,
  selectedEdge: null,
  activeSlice: null,
  activeKind: null,
  searchQuery: '',
  activeTab: 'graph',

  setModel: (model) =>
    set({
      model,
      selectedNode: null,
      selectedEdge: null,
      activeSlice: null,
      activeKind: null,
      searchQuery: '',
    }),
  setSelectedNode: (id) => set({ selectedNode: id, selectedEdge: null }),
  setSelectedEdge: (id) => set({ selectedEdge: id, selectedNode: null }),
  setActiveSlice: (slice) => set({ activeSlice: slice }),
  setActiveKind: (kind) => set({ activeKind: kind }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  reset: () =>
    set({
      model: null,
      selectedNode: null,
      selectedEdge: null,
      activeSlice: null,
      activeKind: null,
      searchQuery: '',
      activeTab: 'graph',
    }),
}));

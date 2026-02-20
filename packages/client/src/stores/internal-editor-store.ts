import { create } from 'zustand';

interface InternalEditorState {
  isOpen: boolean;
  filePath: string | null;
  openFile: (path: string) => void;
  closeEditor: () => void;
}

export const useInternalEditorStore = create<InternalEditorState>((set) => ({
  isOpen: false,
  filePath: null,
  openFile: (path) => set({ isOpen: true, filePath: path }),
  closeEditor: () => set({ isOpen: false, filePath: null }),
}));

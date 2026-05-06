import { create } from 'zustand';

interface MediaPreviewState {
  isOpen: boolean;
  filePath: string | null;
  open: (path: string) => void;
  close: () => void;
}

export const useMediaPreviewStore = create<MediaPreviewState>((set) => ({
  isOpen: false,
  filePath: null,
  open: (path) => set({ isOpen: true, filePath: path }),
  close: () => set({ isOpen: false, filePath: null }),
}));

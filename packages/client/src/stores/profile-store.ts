import type { UserProfile } from '@funny/shared';
import { create } from 'zustand';

/**
 * Global profile cache.
 *
 * Populated once by main.tsx AuthGate after login.
 * Components that only need a single profile field (e.g. hasAssemblyaiKey)
 * read from here instead of issuing their own GET /profile request.
 */
interface ProfileState {
  profile: UserProfile | null;
  setProfile: (profile: UserProfile) => void;
}

export const useProfileStore = create<ProfileState>((set) => ({
  profile: null,
  setProfile: (profile) => set({ profile }),
}));

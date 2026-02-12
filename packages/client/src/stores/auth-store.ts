import { create } from 'zustand';
import type { AuthMode, SafeUser } from '@a-parallel/shared';
import { authClient } from '@/lib/auth-client';
import { initAuth, setAuthMode } from '@/lib/api';

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
const BASE = isTauri ? `http://localhost:${serverPort}/api` : '/api';

interface AuthState {
  mode: AuthMode | null;
  user: SafeUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  /** Fetch auth mode from server, then check session or token */
  initialize: () => Promise<void>;
  /** Login with username + password (multi mode only) */
  login: (username: string, password: string) => Promise<void>;
  /** Logout (multi mode only) */
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  mode: null,
  user: null,
  isAuthenticated: false,
  isLoading: true,

  initialize: async () => {
    console.log('[auth-store] initialize() called, BASE=', BASE);
    set({ isLoading: true });

    try {
      // 1. Fetch auth mode from server
      console.log('[auth-store] fetching /auth/mode...');
      const res = await fetch(`${BASE}/auth/mode`);
      console.log('[auth-store] /auth/mode response:', res.status);
      if (!res.ok) {
        // Fallback to local if mode endpoint unavailable
        console.log('[auth-store] /auth/mode not ok, falling back to local');
        set({ mode: 'local', isAuthenticated: false, isLoading: false });
        return;
      }
      const { mode } = await res.json() as { mode: AuthMode };
      console.log('[auth-store] mode =', mode);
      set({ mode });
      setAuthMode(mode);

      if (mode === 'local') {
        // Local mode — use existing token flow
        console.log('[auth-store] calling initAuth()...');
        await initAuth();
        console.log('[auth-store] initAuth() done, setting isLoading=false');
        set({ isAuthenticated: true, isLoading: false, user: null });
      } else {
        // Multi mode — check Better Auth session
        console.log('[auth-store] multi mode, checking session...');
        const session = await authClient.getSession();
        console.log('[auth-store] session result:', session);
        if (session.data?.user) {
          const u = session.data.user as any;
          set({
            isAuthenticated: true,
            isLoading: false,
            user: {
              id: u.id,
              username: u.username || u.name || 'user',
              displayName: u.name || u.username || 'User',
              role: u.role || 'user',
            },
          });
        } else {
          set({ isAuthenticated: false, isLoading: false, user: null });
        }
      }
    } catch (err) {
      console.error('[auth-store] initialization error:', err);
      set({ mode: 'local', isAuthenticated: false, isLoading: false });
    }
    console.log('[auth-store] initialize() finished');
  },

  login: async (username: string, password: string) => {
    const result = await authClient.signIn.username({
      username,
      password,
    });

    if (result.error) {
      throw new Error(result.error.message || 'Login failed');
    }

    const u = result.data?.user as any;
    if (u) {
      set({
        isAuthenticated: true,
        user: {
          id: u.id,
          username: u.username || u.name || 'user',
          displayName: u.name || u.username || 'User',
          role: u.role || 'user',
        },
      });
    }
  },

  logout: async () => {
    try {
      await authClient.signOut();
    } catch {
      // Ignore errors
    }
    set({ isAuthenticated: false, user: null });
  },
}));

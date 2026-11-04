/**
 * Mobile auth store — Zustand. Logic mirrors packages/core/auth/store.ts:
 *   - Token written only after email verification or external token validation
 *   - 401 → clear token; non-401 (5xx / network blip) → preserve token so
 *     the next launch can retry
 *   - logout = clear token + clear in-memory user + setToken(null)
 *
 * NOT shared with web/desktop (per Sharing Principles in root CLAUDE.md).
 * Storage backend is expo-secure-store (mobile only); web uses HttpOnly
 * cookies, desktop uses localStorage via StorageAdapter.
 */
import { create } from "zustand";
import type { User } from "@multica/core/types";
import { api, ApiError } from "./api";
import { clearToken, getToken, setToken } from "./secure-storage";
import { invalidateSessionEpoch } from "./session-epoch";
import { useWorkspaceStore } from "./workspace-store";
import { useServerStore } from "./server-store";
import {
  clearCachedUser,
  readCachedUser,
  writeCachedUser,
} from "./auth-cache";
import { clearSessionCache } from "./clear-session-cache";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isRestoredOffline: boolean;
  initialize: () => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<User>;
  loginWithToken: (token: string) => Promise<User>;
  logout: () => Promise<void>;
  /** Overwrite the in-memory user — call after PATCH /api/me so name/avatar
   *  edits land without a refetch. Server response is the source of truth. */
  setUser: (user: User) => void;
}

function assertValidSession(token: string, user: User): void {
  if (!token.trim() || !user.id) {
    throw new Error("Invalid authentication response");
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isRestoredOffline: false,

  initialize: async () => {
    await useServerStore.getState().initialize();

    // Restore the persisted workspace slug alongside the auth token so the
    // entry redirect (app/index.tsx) can route directly to the last-used
    // workspace without flashing /select-workspace.
    await useWorkspaceStore.getState().restoreSlug();

    const token = await getToken();
    if (!token) {
      set({ user: null, isLoading: false, isRestoredOffline: false });
      return;
    }
    api.setToken(token);
    try {
      const user = await api.getMe();
      await writeCachedUser(user).catch(() => {});
      set({ user, isLoading: false, isRestoredOffline: false });
    } catch (err) {
      // Only clear token on a genuine 401. Network blips / 5xx keep the
      // token so the next launch (or a manual refresh) can retry.
      if (err instanceof ApiError && err.status === 401) {
        // Synchronous first, before the awaited delete: anything already
        // in flight has to learn the credential is dead now, not once the
        // Keychain write lands.
        invalidateSessionEpoch();
        await Promise.allSettled([clearToken(), clearCachedUser()]);
        api.setToken(null);
        set({ user: null, isLoading: false, isRestoredOffline: false });
        return;
      }
      const cachedUser = await readCachedUser().catch(() => null);
      set({
        user: cachedUser,
        isLoading: false,
        isRestoredOffline: cachedUser !== null,
      });
    }
  },

  sendCode: async (email) => {
    await api.sendCode(email);
  },

  verifyCode: async (email, code) => {
    const { token, user } = await api.verifyCode(email, code);
    assertValidSession(token, user);
    // Signing in replaces the credential just as decisively as signing out:
    // a renewal still in flight for the previous account must not write its
    // result over this one.
    invalidateSessionEpoch();
    await setToken(token);
    await clearSessionCache();
    await writeCachedUser(user).catch(() => {});
    api.setToken(token);
    set({ user, isRestoredOffline: false });
    return user;
  },

  loginWithToken: async (token) => {
    const normalizedToken = token.trim();
    if (!normalizedToken) throw new Error("Invalid authentication response");

    const previousToken = api.getToken();
    invalidateSessionEpoch();
    api.setToken(normalizedToken);
    try {
      const user = await api.getMe();
      assertValidSession(normalizedToken, user);
      await setToken(normalizedToken);
      await clearSessionCache();
      await writeCachedUser(user).catch(() => {});
      api.setToken(normalizedToken);
      set({ user, isRestoredOffline: false });
      return user;
    } catch (error) {
      api.setToken(previousToken);
      throw error;
    }
  },

  logout: async () => {
    // First statement in the function, before any await. The Keychain delete
    // below is async, so until it lands a concurrent read still returns the
    // token being removed — the epoch is what makes this instant.
    invalidateSessionEpoch();
    await Promise.allSettled([
      clearToken(),
      clearCachedUser(),
      clearSessionCache(),
    ]);
    api.setToken(null);
    set({ user: null, isRestoredOffline: false });
  },

  setUser: (user) => {
    void writeCachedUser(user).catch(() => {});
    set({ user });
  },
}));

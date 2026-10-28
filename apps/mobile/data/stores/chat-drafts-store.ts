import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const DRAFT_NEW_SESSION = "__new__";

export function chatDraftKey(
  workspaceId: string,
  sessionId: string,
): string {
  return `${workspaceId}:${sessionId}`;
}

interface ChatDraftsState {
  drafts: Record<string, string>;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
  clearAll: () => void;
  promoteDraft: (sourceKey: string, targetKey: string) => void;
}

export function mergeChatDrafts(
  persisted: Record<string, string> | undefined,
  current: Record<string, string>,
): Record<string, string> {
  return { ...persisted, ...current };
}

export const useChatDraftsStore = create<ChatDraftsState>()(
  persist(
    (set, get) => ({
      drafts: {},
      setDraft: (key, text) => {
        const current = get().drafts;
        if (current[key] === text) return;
        if (text === "") {
          if (!(key in current)) return;
          const next = { ...current };
          delete next[key];
          set({ drafts: next });
          return;
        }
        set({ drafts: { ...current, [key]: text } });
      },
      clearDraft: (key) => {
        const current = get().drafts;
        if (!(key in current)) return;
        const next = { ...current };
        delete next[key];
        set({ drafts: next });
      },
      clearAll: () => set({ drafts: {} }),
      promoteDraft: (sourceKey, targetKey) => {
        const current = get().drafts;
        const pending = current[sourceKey];
        if (!pending) return;
        const next = { ...current, [targetKey]: pending };
        delete next[sourceKey];
        set({ drafts: next });
      },
    }),
    {
      name: "multica-mobile-chat-drafts-v1",
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ drafts: state.drafts }),
      merge: (persisted, current) => {
        const state = persisted as Partial<ChatDraftsState> | undefined;
        return {
          ...current,
          drafts: mergeChatDrafts(state?.drafts, current.drafts),
        };
      },
    },
  ),
);

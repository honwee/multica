import { useEffect, useRef } from "react";
import { create } from "zustand";

interface ChatAgentPickerState {
  selectRequest: { id: string; nonce: number } | null;
  requestSelect: (id: string) => void;
  consumeSelect: () => void;
  reset: () => void;
}

export const useChatAgentPickerStore = create<ChatAgentPickerState>(
  (set, get) => ({
    selectRequest: null,
    requestSelect: (id) =>
      set({
        selectRequest: {
          id,
          nonce: (get().selectRequest?.nonce ?? 0) + 1,
        },
      }),
    consumeSelect: () => set({ selectRequest: null }),
    reset: () => set({ selectRequest: null }),
  }),
);

export function useChatAgentPickerResetOnWorkspaceChange(
  wsId: string | null,
) {
  const prevRef = useRef(wsId);
  useEffect(() => {
    if (prevRef.current !== wsId) {
      useChatAgentPickerStore.getState().reset();
      prevRef.current = wsId;
    }
  }, [wsId]);
}

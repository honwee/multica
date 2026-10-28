import { create } from "zustand";

export interface RunNotice {
  taskId: string;
  issueId: string;
  chatSessionId?: string;
}

interface RunNoticeState {
  notice: RunNotice | null;
  showNotice: (notice: RunNotice) => void;
  dismissNotice: (taskId?: string) => void;
}

export const useRunNoticeStore = create<RunNoticeState>((set, get) => ({
  notice: null,
  showNotice: (notice) => {
    if (get().notice?.taskId === notice.taskId) return;
    set({ notice });
  },
  dismissNotice: (taskId) => {
    if (taskId && get().notice?.taskId !== taskId) return;
    set({ notice: null });
  },
}));

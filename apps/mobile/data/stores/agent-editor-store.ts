import { create } from "zustand";
import type { Agent, RuntimeDevice } from "@multica/core/types";
import {
  initialAgentFormValues,
  type AgentFormValues,
} from "@/lib/agent-form";

interface AgentEditorState {
  sessionKey: string | null;
  values: AgentFormValues;
  initialize: (
    sessionKey: string,
    agent: Agent | undefined,
    runtimes: RuntimeDevice[],
  ) => void;
  setValue: <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => void;
  selectRuntime: (runtimeId: string) => void;
  reset: () => void;
}

export const useAgentEditorStore = create<AgentEditorState>((set, get) => ({
  sessionKey: null,
  values: initialAgentFormValues(undefined, []),
  initialize: (sessionKey, agent, runtimes) => {
    // React Navigation can remount a pushed route. Reopening the same editor
    // must not erase an in-progress draft; only a different editing session
    // is allowed to replace it.
    if (get().sessionKey === sessionKey) return;
    set({
      sessionKey,
      values: initialAgentFormValues(agent, runtimes),
    });
  },
  setValue: (key, value) =>
    set((state) => ({
      values: { ...state.values, [key]: value },
    })),
  selectRuntime: (runtimeId) =>
    set((state) => ({
      values: {
        ...state.values,
        runtimeId,
        model: state.values.runtimeId === runtimeId ? state.values.model : "",
      },
    })),
  reset: () =>
    set({
      sessionKey: null,
      values: initialAgentFormValues(undefined, []),
    }),
}));

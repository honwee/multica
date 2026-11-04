import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@multica/core/types";
import { useAgentEditorStore } from "./agent-editor-store";

describe("agent editor store", () => {
  beforeEach(() => useAgentEditorStore.getState().reset());

  it("preserves a draft when the same editor remounts", () => {
    const store = useAgentEditorStore.getState();
    store.initialize("create", undefined, []);
    store.setValue("name", "E2E-temp");

    useAgentEditorStore.getState().initialize("create", undefined, []);

    expect(useAgentEditorStore.getState().values.name).toBe("E2E-temp");
  });

  it("starts a different editing session with the agent configuration", () => {
    const store = useAgentEditorStore.getState();
    store.initialize("create", undefined, []);
    store.setValue("name", "Draft");
    const agent = { id: "agent-1", name: "Existing" } as Agent;

    useAgentEditorStore.getState().initialize("agent-1", agent, []);

    expect(useAgentEditorStore.getState().values.name).toBe("Existing");
  });

  it("clears the editing session on reset", () => {
    const store = useAgentEditorStore.getState();
    store.initialize("create", undefined, []);
    store.setValue("name", "Draft");

    useAgentEditorStore.getState().reset();

    expect(useAgentEditorStore.getState().sessionKey).toBeNull();
    expect(useAgentEditorStore.getState().values.name).toBe("");
  });
});

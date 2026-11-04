import { beforeEach, describe, expect, it } from "vitest";
import { useAgentEditorStore } from "./agent-editor-store";

beforeEach(() => useAgentEditorStore.getState().reset());

describe("agent editor runtime selection", () => {
  it("resets only the model when changing runtimes and preserves the draft", () => {
    const store = useAgentEditorStore.getState();
    store.initialize("create", undefined, []);
    store.setValue("name", "Draft name");
    store.setValue("description", "Draft description");
    store.setValue("instructions", "Keep advanced setup intact");
    store.setValue("runtimeId", "runtime-old");
    store.setValue("model", "custom-old");
    store.setValue("visibility", "private");

    useAgentEditorStore.getState().selectRuntime("runtime-new");

    expect(useAgentEditorStore.getState().values).toEqual({
      name: "Draft name",
      description: "Draft description",
      instructions: "Keep advanced setup intact",
      runtimeId: "runtime-new",
      model: "",
      visibility: "private",
    });
  });

  it("keeps a saved custom model when reselecting the same runtime", () => {
    const store = useAgentEditorStore.getState();
    store.initialize("create", undefined, []);
    store.setValue("runtimeId", "runtime-1");
    store.setValue("model", "custom-model");

    useAgentEditorStore.getState().selectRuntime("runtime-1");

    expect(useAgentEditorStore.getState().values.model).toBe("custom-model");
  });
});

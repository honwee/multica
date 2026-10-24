import { beforeEach, describe, expect, it } from "vitest";
import { useChatAgentPickerStore } from "./chat-agent-picker-store";

const store = () => useChatAgentPickerStore.getState();

describe("chat agent picker store", () => {
  beforeEach(() => {
    store().reset();
  });

  it("consumes a selection exactly once", () => {
    store().requestSelect("agent-1");
    expect(store().selectRequest).toEqual({ id: "agent-1", nonce: 1 });

    store().consumeSelect();
    expect(store().selectRequest).toBeNull();
  });

  it("creates a new request when the same agent is selected again", () => {
    store().requestSelect("agent-1");
    const first = store().selectRequest;
    store().consumeSelect();

    store().requestSelect("agent-1");
    expect(store().selectRequest).not.toBe(first);
    expect(store().selectRequest?.id).toBe("agent-1");
  });

  it("distinguishes rapid requests with a nonce", () => {
    store().requestSelect("agent-1");
    store().requestSelect("agent-2");

    expect(store().selectRequest).toEqual({ id: "agent-2", nonce: 2 });
  });

  it("clears pending selections on workspace reset", () => {
    store().requestSelect("agent-1");
    store().reset();

    expect(store().selectRequest).toBeNull();
  });
});

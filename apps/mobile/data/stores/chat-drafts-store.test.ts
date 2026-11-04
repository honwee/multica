import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatDraftKey,
  DRAFT_NEW_SESSION,
  mergeChatDrafts,
  useChatDraftsStore,
} from "./chat-drafts-store";

const storage = vi.hoisted(() => ({
  getItem: vi.fn(() => Promise.resolve(null)),
  setItem: vi.fn(() => Promise.resolve()),
  removeItem: vi.fn(() => Promise.resolve()),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storage,
}));

const store = () => useChatDraftsStore.getState();

describe("chat drafts", () => {
  beforeEach(() => {
    store().clearAll();
    storage.setItem.mockClear();
  });

  it("isolates new and existing sessions by workspace", () => {
    const first = chatDraftKey("ws-1", DRAFT_NEW_SESSION);
    const second = chatDraftKey("ws-2", DRAFT_NEW_SESSION);
    store().setDraft(first, "first workspace");
    store().setDraft(second, "second workspace");

    expect(store().drafts[first]).toBe("first workspace");
    expect(store().drafts[second]).toBe("second workspace");
  });

  it("persists drafts outside SecureStore", () => {
    const key = chatDraftKey("ws-1", "session-1");
    store().setDraft(key, "keep me");

    expect(storage.setItem).toHaveBeenCalledWith(
      "multica-mobile-chat-drafts-v1",
      expect.stringContaining("keep me"),
    );
  });

  it("promotes only the source draft to a newly created session", () => {
    const source = chatDraftKey("ws-1", DRAFT_NEW_SESSION);
    const target = chatDraftKey("ws-1", "session-1");
    store().setDraft(source, "first message follow-up");
    store().promoteDraft(source, target);

    expect(store().drafts[source]).toBeUndefined();
    expect(store().drafts[target]).toBe("first message follow-up");
  });

  it("lets typing before hydration win over the persisted value", () => {
    expect(
      mergeChatDrafts(
        { "ws-1:session-1": "persisted", "ws-1:session-2": "restored" },
        { "ws-1:session-1": "new typing" },
      ),
    ).toEqual({
      "ws-1:session-1": "new typing",
      "ws-1:session-2": "restored",
    });
  });
});

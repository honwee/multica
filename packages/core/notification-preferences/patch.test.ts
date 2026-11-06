import { describe, expect, it } from "vitest";
import {
  applyNotificationPreferencePatch,
  deriveNotificationPreferencePatch,
  notificationPreferenceValue,
  rollbackNotificationPreferencePatch,
} from "./patch";

describe("notification preference patches", () => {
  it("sends only the changed key when another muted preference is present", () => {
    expect(
      deriveNotificationPreferencePatch(
        { status_changes: "muted" },
        { status_changes: "muted", comments: "muted" },
      ),
    ).toEqual({ comments: "muted" });
  });

  it("uses an explicit all value when enabling a previously muted group", () => {
    expect(
      deriveNotificationPreferencePatch(
        { status_changes: "muted", comments: "muted" },
        { comments: "muted" },
      ),
    ).toEqual({ status_changes: "all" });
  });

  it("merges optimistic patches without dropping unrelated preferences", () => {
    expect(
      applyNotificationPreferencePatch(
        { status_changes: "muted" },
        { comments: "muted" },
      ),
    ).toEqual({ status_changes: "muted", comments: "muted" });
  });

  it("carries the mentions group independently of comments", () => {
    // The point of the split (#6468): muting comment volume must not travel
    // to mentions. A missing key in NOTIFICATION_GROUP_KEYS would make the
    // toggle silently un-sendable, so derive and apply are both covered.
    expect(
      deriveNotificationPreferencePatch(
        { comments: "muted" },
        { comments: "muted", mentions: "muted" },
      ),
    ).toEqual({ mentions: "muted" });

    expect(
      deriveNotificationPreferencePatch({ comments: "muted" }, {}),
    ).toEqual({ comments: "all" });

    expect(
      applyNotificationPreferencePatch(
        { comments: "muted" },
        { mentions: "muted" },
      ),
    ).toEqual({ comments: "muted", mentions: "muted" });
  });

  it("does not roll back a key that a later mutation already changed", () => {
    expect(
      rollbackNotificationPreferencePatch(
        { comments: "muted" },
        { comments: "muted" },
        {},
      ),
    ).toEqual({});

    expect(
      rollbackNotificationPreferencePatch(
        {},
        { comments: "muted" },
        {},
      ),
    ).toEqual({});
  });
});

describe("feishu_notifications defaults to off", () => {
  it("reads a missing key as muted", () => {
    expect(notificationPreferenceValue({}, "feishu_notifications")).toBe("muted");
    expect(notificationPreferenceValue({}, "comments")).toBe("all");
  });

  it("sends all when turning it on and muted when turning it off", () => {
    expect(
      deriveNotificationPreferencePatch({}, { feishu_notifications: "all" }),
    ).toEqual({ feishu_notifications: "all" });
    expect(
      deriveNotificationPreferencePatch({ feishu_notifications: "all" }, {}),
    ).toEqual({ feishu_notifications: "muted" });
  });

  it("keeps the opt-in sparse in the optimistic cache", () => {
    expect(
      applyNotificationPreferencePatch({}, { feishu_notifications: "all" }),
    ).toEqual({ feishu_notifications: "all" });
    expect(
      applyNotificationPreferencePatch(
        { feishu_notifications: "all", comments: "muted" },
        { feishu_notifications: "muted" },
      ),
    ).toEqual({ comments: "muted" });
  });

  it("rolls a failed opt-in back to off", () => {
    expect(
      rollbackNotificationPreferencePatch(
        { feishu_notifications: "all" },
        { feishu_notifications: "all" },
        {},
      ),
    ).toEqual({});
  });
});

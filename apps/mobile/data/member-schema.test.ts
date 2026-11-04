import { describe, expect, it } from "vitest";
import { InvitationSchema } from "./schemas";

describe("invitation response schema", () => {
  it("accepts a server invitation with a nullable registered user", () => {
    expect(InvitationSchema.parse({
      id: "invitation-1",
      workspace_id: "ws-1",
      inviter_id: "user-1",
      invitee_email: "ou_internal@feishu.invalid",
      invitee_name: "陈弘唯",
      invitee_user_id: null,
      role: "member",
      status: "pending",
      created_at: "2026-10-30T00:00:00Z",
      updated_at: "2026-10-30T00:00:00Z",
      expires_at: "2026-11-06T00:00:00Z",
    })).toMatchObject({ id: "invitation-1", invitee_user_id: null });
  });

  it("rejects malformed identifiers instead of fabricating an invitation", () => {
    expect(InvitationSchema.safeParse({ id: 42, invitee_email: null }).success).toBe(false);
  });
});

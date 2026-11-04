import { describe, expect, it } from "vitest";
import type { LarkOrganizationUser, MemberWithUser } from "@multica/core/types";
import { memberActionPermissions, searchFeishuDirectory } from "./member-directory";

const directoryUser: LarkOrganizationUser = {
  union_id: "union-1",
  name: "陈弘唯",
  job_title: "前端工程师",
  departments: ["技术中心", "AI"],
  active: true,
  workspace_member: false,
};

const member: MemberWithUser = {
  id: "member-1",
  workspace_id: "ws-1",
  user_id: "user-1",
  role: "member",
  created_at: "",
  name: "Member",
  email: "member@example.test",
  avatar_url: null,
};

describe("member directory", () => {
  it("finds active people by Feishu name, title, or department", () => {
    expect(searchFeishuDirectory([directoryUser], "陈弘唯")).toHaveLength(1);
    expect(searchFeishuDirectory([directoryUser], "前端")).toHaveLength(1);
    expect(searchFeishuDirectory([directoryUser], "技术中心")).toHaveLength(1);
    expect(searchFeishuDirectory([directoryUser], "missing")).toHaveLength(0);
  });

  it("does not offer inactive or existing members for invitation", () => {
    expect(
      searchFeishuDirectory([
        directoryUser,
        { ...directoryUser, union_id: "inactive", active: false },
        { ...directoryUser, union_id: "joined", workspace_member: true },
      ], "陈"),
    ).toHaveLength(1);
  });

  it("does not let admins edit owners or let anyone remove the last owner", () => {
    const admin = { ...member, role: "admin" as const };
    const owner = { ...member, id: "owner", user_id: "owner", role: "owner" as const };
    expect(memberActionPermissions(admin, owner, 2)).toMatchObject({
      canEditRole: false,
      canRemove: false,
    });
    expect(memberActionPermissions(owner, owner, 1)).toMatchObject({
      canRemove: false,
      roles: ["owner"],
    });
  });
});

import type {
  LarkOrganizationUser,
  MemberRole,
  MemberWithUser,
} from "@multica/core/types";

export function searchFeishuDirectory(
  users: LarkOrganizationUser[] | undefined,
  query: string,
): LarkOrganizationUser[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return (users ?? [])
    .filter(
      (candidate) =>
        candidate.active &&
        !candidate.workspace_member &&
        `${candidate.name} ${candidate.job_title} ${candidate.departments.join(" ")}`
          .toLocaleLowerCase()
          .includes(needle),
    )
    .slice(0, 8);
}

export function memberActionPermissions(
  currentMember: MemberWithUser | undefined,
  target: MemberWithUser,
  ownerCount: number,
): { canEditRole: boolean; canRemove: boolean; roles: MemberRole[] } {
  const canManage =
    currentMember?.role === "owner" || currentMember?.role === "admin";
  const isOwner = currentMember?.role === "owner";
  const isSelf = currentMember?.user_id === target.user_id;
  const canManageTarget =
    canManage && !isSelf && (target.role !== "owner" || isOwner);
  const isLastOwner = target.role === "owner" && ownerCount <= 1;
  const roles: MemberRole[] = isOwner
    ? ["member", "admin", "owner"]
    : ["member", "admin"];

  return {
    canEditRole: canManageTarget,
    canRemove: canManageTarget && !isLastOwner,
    roles: isLastOwner ? roles.filter((role) => role === "owner") : roles,
  };
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MemberRole } from "@multica/core/types";
import { api } from "@/data/api";
import { memberKeys } from "@/data/queries/members";
import { useWorkspaceStore } from "@/data/workspace-store";

function useMemberCacheRefresh() {
  const qc = useQueryClient();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: memberKeys.list(wsId) }),
      qc.invalidateQueries({ queryKey: memberKeys.invitations(wsId) }),
    ]);
}

export function useUpdateMemberRole() {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const refresh = useMemberCacheRefresh();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: MemberRole }) =>
      api.updateMember(wsId!, memberId, { role }),
    onSettled: refresh,
  });
}

export function useRemoveMember() {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const refresh = useMemberCacheRefresh();
  return useMutation({
    mutationFn: (memberId: string) => api.deleteMember(wsId!, memberId),
    onSettled: refresh,
  });
}

export function useRevokeInvitation() {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const refresh = useMemberCacheRefresh();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.revokeInvitation(wsId!, invitationId),
    onSettled: refresh,
  });
}

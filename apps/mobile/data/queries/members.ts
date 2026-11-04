import { queryOptions } from "@tanstack/react-query";
import { api } from "@/data/api";

export const memberKeys = {
  list: (wsId: string | null) => ["members", wsId] as const,
  invitations: (wsId: string | null) => ["invitations", wsId] as const,
};

export const memberListOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: memberKeys.list(wsId),
    queryFn: ({ signal }) => api.listMembers(wsId!, { signal }),
    enabled: !!wsId,
  });

export const invitationListOptions = (wsId: string | null, enabled = true) =>
  queryOptions({
    queryKey: memberKeys.invitations(wsId),
    queryFn: ({ signal }) => api.listInvitations(wsId!, { signal }),
    enabled: !!wsId && enabled,
  });

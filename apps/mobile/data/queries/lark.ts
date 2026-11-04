import { queryOptions } from "@tanstack/react-query";
import { api } from "@/data/api";

export const larkKeys = {
  organization: (wsId: string | null) =>
    ["lark", wsId, "organization"] as const,
};

export const larkOrganizationOptions = (
  wsId: string | null,
  enabled = true,
) =>
  queryOptions({
    queryKey: larkKeys.organization(wsId),
    queryFn: ({ signal }) => api.getLarkOrganization(wsId!, { signal }),
    enabled: !!wsId && enabled,
  });

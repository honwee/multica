import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/** Query key namespace for Lark settings. Realtime sync invalidates
 * `installations(wsId)` on `lark_installation:*` events so the Settings panel
 * updates without a refetch. */
export const larkKeys = {
  all: (wsId: string) => ["lark", wsId] as const,
  installations: (wsId: string) => [...larkKeys.all(wsId), "installations"] as const,
  organization: (wsId: string) => [...larkKeys.all(wsId), "organization"] as const,
  organizationGroups: (wsId: string) => [...larkKeys.all(wsId), "organization", "groups"] as const,
  botInfo: (wsId: string, installationId: string) => [...larkKeys.all(wsId), "bot-info", installationId] as const,
};

export const larkInstallationsOptions = (wsId: string) =>
  queryOptions({
    queryKey: larkKeys.installations(wsId),
    queryFn: () => api.listLarkInstallations(wsId),
    enabled: !!wsId,
    // Poll only while mounted and awaiting proof; silence never becomes failure.
    refetchInterval: (query) =>
      query.state.data?.installations.some(
        (inst) => inst.status === "active" && !inst.first_message_received_at,
      ) ? 5000 : false,
  });

export const larkOrganizationOptions = (wsId: string) =>
  queryOptions({
    queryKey: larkKeys.organization(wsId),
    queryFn: () => api.getLarkOrganization(wsId),
    enabled: !!wsId,
  });

export const larkBotInfoOptions = (wsId: string, installationId: string, enabled: boolean) =>
  queryOptions({
    queryKey: larkKeys.botInfo(wsId, installationId),
    queryFn: () => api.getLarkInstallationBotInfo(wsId, installationId),
    enabled: enabled && !!wsId && !!installationId,
    staleTime: 5 * 60 * 1000,
  });

/** Applied organization groups, readable by every member for agent access. */
export const larkOrganizationGroupsOptions = (wsId: string) =>
  queryOptions({
    queryKey: larkKeys.organizationGroups(wsId),
    queryFn: () => api.listLarkOrganizationGroups(wsId),
    enabled: !!wsId,
    staleTime: 60 * 1000,
  });

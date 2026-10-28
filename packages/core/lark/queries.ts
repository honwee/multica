import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/** Query key namespace for Lark settings. Realtime sync invalidates
 * `installations(wsId)` on `lark_installation:*` events so the Settings panel
 * updates without a refetch. */
export const larkKeys = {
  all: (wsId: string) => ["lark", wsId] as const,
  installations: (wsId: string) => [...larkKeys.all(wsId), "installations"] as const,
  organization: (wsId: string) => [...larkKeys.all(wsId), "organization"] as const,
  botInfo: (wsId: string, installationId: string) => [...larkKeys.all(wsId), "bot-info", installationId] as const,
};

export const larkInstallationsOptions = (wsId: string) =>
  queryOptions({
    queryKey: larkKeys.installations(wsId),
    queryFn: () => api.listLarkInstallations(wsId),
    enabled: !!wsId,
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

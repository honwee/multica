import { ActivityIndicator, View } from "react-native";
import { Stack } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { AgentEditorForm } from "@/components/agent/agent-editor-form";
import { ModalCloseButton } from "@/components/ui/modal-close-button";
import { Text } from "@/components/ui/text";
import { agentDetailOptions } from "@/data/queries/agents";
import { memberListOptions } from "@/data/queries/members";
import { runtimeListOptions } from "@/data/queries/runtimes";
import { useAuthStore } from "@/data/auth-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";

export function AgentEditorRoute({ agentId }: { agentId?: string }) {
  const { t } = useT("workspace");
  const mode = agentId ? "edit" : "create";
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const agentQuery = useQuery(agentDetailOptions(agentId ?? null));
  const membersQuery = useQuery(memberListOptions(wsId));
  const runtimesQuery = useQuery(runtimeListOptions(wsId));
  const memberRole = membersQuery.data?.find((member) => member.user_id === userId)?.role;
  const canManage = memberRole === "owner" || memberRole === "admin";
  const isLoading =
    membersQuery.isLoading ||
    runtimesQuery.isLoading ||
    (agentId ? agentQuery.isLoading : false);
  const error = agentQuery.error ?? membersQuery.error ?? runtimesQuery.error;

  return (
    <>
      <Stack.Screen
        options={{
          title: t(`agent.editor.title_${mode}`),
          presentation: "modal",
          headerLeft: () => <ModalCloseButton />,
        }}
      />
      {isLoading ? (
        <View className="flex-1 items-center justify-center bg-background">
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View className="flex-1 bg-background px-4 pt-4">
          <Text className="text-sm text-destructive">
            {error instanceof Error ? error.message : t("common:states.error")}
          </Text>
        </View>
      ) : !canManage ? (
        <View className="flex-1 items-center justify-center bg-background px-6">
          <Text className="text-center text-sm text-muted-foreground">
            {t("agent.editor.no_permission")}
          </Text>
        </View>
      ) : (
        <AgentEditorForm
          mode={mode}
          agent={agentId ? agentQuery.data : undefined}
          runtimes={runtimesQuery.data ?? []}
          userId={userId}
        />
      )}
    </>
  );
}

import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { AgentRow } from "@/components/agent/agent-row";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuthStore } from "@/data/auth-store";
import { agentListOptions } from "@/data/queries/agents";
import { memberListOptions } from "@/data/queries/members";
import { useChatAgentPickerStore } from "@/data/stores/chat-agent-picker-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import {
  buildAgentListItems,
  type AgentListItem,
} from "@/lib/agent-list";
import { useT } from "@/lib/i18n";
import { useWorkspacePresenceMap } from "@/lib/use-agent-presence";

export default function AgentsPage() {
  const { t } = useT("workspace");
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const requestAgentSelect = useChatAgentPickerStore((s) => s.requestSelect);

  const {
    data: agents = [],
    isLoading: agentsLoading,
    isRefetching: agentsRefetching,
    error: agentsError,
    refetch: refetchAgents,
  } = useQuery(agentListOptions(wsId));
  const {
    data: members = [],
    isLoading: membersLoading,
    isRefetching: membersRefetching,
    error: membersError,
    refetch: refetchMembers,
  } = useQuery(memberListOptions(wsId));
  const { byAgent } = useWorkspacePresenceMap(wsId);

  const memberRole = useMemo(
    () => members.find((member) => member.user_id === userId)?.role ?? null,
    [members, userId],
  );
  const items = useMemo(
    () =>
      buildAgentListItems({
        agents,
        presenceByAgent: byAgent,
        userId,
        role: memberRole,
      }),
    [agents, byAgent, userId, memberRole],
  );

  const openAgent = useCallback(
    (item: AgentListItem) => {
      if (item.disabledReason || !wsSlug) return;
      requestAgentSelect(item.agent.id);
      router.navigate({
        pathname: "/[workspace]/chat",
        params: { workspace: wsSlug },
      });
    },
    [requestAgentSelect, wsSlug],
  );

  const refresh = useCallback(() => {
    void refetchAgents();
    void refetchMembers();
  }, [refetchAgents, refetchMembers]);
  const loadError = agentsError ?? membersError;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={[]}>
      {agentsLoading || membersLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : loadError ? (
        <View className="gap-3 px-4 pt-4">
          <Text className="text-sm text-destructive">
            {t("agent.errors.load_failed", {
              message:
                loadError instanceof Error ? loadError.message : "unknown",
            })}
          </Text>
          <Button variant="outline" className="self-start" onPress={refresh}>
            <Text>{t("common:actions.retry")}</Text>
          </Button>
        </View>
      ) : items.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-2 px-6">
          <Text className="text-base font-medium text-foreground">
            {t("agent.empty")}
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            {t("agent.empty_detail")}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.agent.id}
          renderItem={({ item }) => (
            <AgentRow item={item} onPress={() => openAgent(item)} />
          )}
          ItemSeparatorComponent={() => (
            <View className="ml-4 h-px bg-border" />
          )}
          refreshControl={
            <RefreshControl
              refreshing={agentsRefetching || membersRefetching}
              onRefresh={refresh}
            />
          }
          contentContainerClassName="pb-6"
        />
      )}
    </SafeAreaView>
  );
}

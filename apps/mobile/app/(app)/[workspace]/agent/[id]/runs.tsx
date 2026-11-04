import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { AgentRuns } from "@/components/agent/agent-runs";
import { agentDetailOptions } from "@/data/queries/agents";
import { useT } from "@/lib/i18n";

export default function AgentRunsPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useT("workspace");
  const agentQuery = useQuery(agentDetailOptions(id));

  return (
    <>
      <Stack.Screen
        options={{
          title: agentQuery.data?.name || t("agent.runs.title"),
          headerBackTitle: t("navigation:back"),
        }}
      />
      <AgentRuns agentId={id} agent={agentQuery.data} />
    </>
  );
}

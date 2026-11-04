import { useLocalSearchParams } from "expo-router";
import { AgentEditorRoute } from "@/components/agent/agent-editor-route";

export default function EditAgentPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentEditorRoute agentId={id} />;
}

import { useLocalSearchParams } from "expo-router";
import { AgentEditorPickerRoute } from "@/components/agent/agent-editor-picker-route";

export default function AgentModelPickerPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentEditorPickerRoute kind="model" agentId={id} />;
}

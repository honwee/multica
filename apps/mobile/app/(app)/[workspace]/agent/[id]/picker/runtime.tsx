import { useLocalSearchParams } from "expo-router";
import { AgentEditorPickerRoute } from "@/components/agent/agent-editor-picker-route";

export default function AgentRuntimePickerPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentEditorPickerRoute kind="runtime" agentId={id} />;
}

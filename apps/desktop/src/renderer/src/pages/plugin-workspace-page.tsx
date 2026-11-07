import { useParams } from "react-router-dom";
import { PluginWorkspacePage } from "@multica/views/plugins";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function PluginWorkspacePageRoute() {
  const { installationId, surfaceKey } = useParams<{ installationId: string; surfaceKey: string }>();
  useDocumentTitle("Plugin");
  if (!installationId || !surfaceKey) return null;
  return <PluginWorkspacePage installationId={installationId} surfaceKey={surfaceKey} />;
}

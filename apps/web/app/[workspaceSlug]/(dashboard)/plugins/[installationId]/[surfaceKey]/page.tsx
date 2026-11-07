"use client";

import { use } from "react";
import { PluginWorkspacePage } from "@multica/views/plugins";

export default function PluginWorkspacePageRoute({
  params,
}: {
  params: Promise<{ installationId: string; surfaceKey: string }>;
}) {
  const { installationId, surfaceKey } = use(params);
  return <PluginWorkspacePage installationId={installationId} surfaceKey={surfaceKey} />;
}

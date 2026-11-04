"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, MemberWithUser } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { larkOrganizationGroupsOptions } from "@multica/core/lark/queries";
import {
  SettingsCard,
  SettingsSection,
} from "../../settings/components/settings-layout";
import { useT } from "../../i18n";
import { AccessPicker, type AccessTeam } from "./inspector/access-picker";

export function AgentAccessSettings({
  agent,
  members,
  currentUserId,
  onDirtyChange,
  onUpdate,
}: {
  agent: Agent;
  members: MemberWithUser[];
  currentUserId: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onUpdate: (id: string, data: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  // Applied organization groups double as team targets. The query is
  // member-visible, so a non-admin owner can still grant their agent to a
  // department.
  const { data: organizationGroups } = useQuery(larkOrganizationGroupsOptions(wsId));
  const teams = useMemo<AccessTeam[]>(
    () => (organizationGroups?.groups ?? []).map((group) => ({ id: group.id, name: group.external_name || group.external_id })),
    [organizationGroups],
  );

  return (
    <SettingsSection
      title={t(($) => $.access.section_title)}
    >
      <SettingsCard>
        <AccessPicker
          permissionMode={agent.permission_mode}
          invocationTargets={agent.invocation_targets}
          visibility={agent.visibility}
          members={members}
          teams={teams}
          ownerId={agent.owner_id}
          canEdit={
            currentUserId !== null && agent.owner_id === currentUserId
          }
          hasComposioAllowlist={
            (agent.composio_toolkit_allowlist ?? []).length > 0
          }
          onDirtyChange={onDirtyChange}
          onChange={(next) => onUpdate(agent.id, next)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

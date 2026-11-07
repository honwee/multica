"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Switch } from "@multica/ui/components/ui/switch";
import { api } from "@multica/core/api";
import {
  pluginExtensionsFromSettings,
  withPluginExtension,
  type PluginExtensionKey,
} from "@multica/core/plugins";
import { workspaceKeys } from "@multica/core/workspace/queries";
import type { Workspace } from "@multica/core/types";
import { useT } from "../../i18n";
import { SettingsCard, SettingsRow, SettingsSection } from "./settings-layout";

/**
 * Fork extension point switches (FORK.md). Both default off; with both off,
 * plugins behave exactly as upstream.
 */
export function PluginExtensionsSection({ workspace, canManage }: { workspace: Workspace; canManage: boolean }) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const [saving, setSaving] = useState<PluginExtensionKey | null>(null);
  const switches = pluginExtensionsFromSettings(workspace.settings);

  async function persist(key: PluginExtensionKey, enabled: boolean) {
    if (saving) return;
    setSaving(key);
    try {
      const updated = await api.updateWorkspace(workspace.id, {
        settings: withPluginExtension(workspace.settings, key, enabled),
      });
      qc.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((ws) => (ws.id === updated.id ? updated : ws)),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.plugins.action_failed));
    } finally {
      setSaving(null);
    }
  }

  return (
    <SettingsSection title={t(($) => $.plugins.extensions.title)}>
      <SettingsCard>
        <SettingsRow anchor="plugin-workspace-pages" label={t(($) => $.plugins.extensions.workspace_pages)}>
          <Switch
            checked={switches.workspace_pages}
            disabled={!canManage || saving !== null}
            onCheckedChange={(value) => persist("workspace_pages", value)}
            aria-label={t(($) => $.plugins.extensions.workspace_pages)}
          />
        </SettingsRow>
        <SettingsRow
          anchor="plugin-card-buttons"
          label={t(($) => $.plugins.extensions.card_buttons)}
          description={t(($) => $.plugins.extensions.card_buttons_description)}
        >
          <Switch
            checked={switches.card_buttons}
            disabled={!canManage || saving !== null}
            onCheckedChange={(value) => persist("card_buttons", value)}
            aria-label={t(($) => $.plugins.extensions.card_buttons)}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { toast } from "sonner";
import { workspaceListOptions } from "@multica/core/workspace";
import { SettingsCard, SettingsSection } from "@multica/views/settings";
import { useT } from "@multica/views/i18n";

/**
 * Picks the workspaces this machine's daemon registers runtimes in. An empty
 * allowlist means every workspace, so it renders with every box checked; the
 * last checked box cannot be cleared, because an empty list would silently
 * widen back to "all".
 */
export function DaemonWorkspaceAllowlist() {
  const { t } = useT("settings");
  const { data: workspaces = [] } = useQuery(workspaceListOptions());
  const [allowlist, setAllowlist] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.daemonAPI.getWorkspaceAllowlist().then(setAllowlist);
  }, []);

  const known = new Set(workspaces.map((ws) => ws.id));
  // IDs for workspaces the account has left are ignored for display, so a
  // stale entry never makes the picker look narrower than it is.
  const selected = (allowlist ?? []).filter((id) => known.has(id));
  const allSelected = selected.length === 0;
  const isChecked = (id: string) => allSelected || selected.includes(id);
  const checkedCount = allSelected ? workspaces.length : selected.length;

  const toggle = useCallback(
    async (id: string, checked: boolean) => {
      const current = allSelected ? workspaces.map((ws) => ws.id) : selected;
      const next = checked
        ? [...current, id]
        : current.filter((existing) => existing !== id);
      const persisted = next.length === workspaces.length ? [] : next;
      setSaving(true);
      try {
        const result = await window.daemonAPI.setWorkspaceAllowlist(persisted);
        if (!result.success) {
          throw new Error(
            result.error ?? t(($) => $.desktop.daemon.settings_save_failed),
          );
        }
        setAllowlist(persisted);
        toast.success(t(($) => $.desktop.daemon.settings_saved), {
          id: "settings-auto-save",
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t(($) => $.desktop.daemon.settings_save_failed),
        );
      } finally {
        setSaving(false);
      }
    },
    [allSelected, selected, workspaces, t],
  );

  if (allowlist === null || workspaces.length === 0) return null;

  return (
    <SettingsSection
      title={t(($) => $.desktop.daemon.workspace_allowlist_title)}
      description={
        allSelected
          ? t(($) => $.desktop.daemon.workspace_allowlist_all)
          : undefined
      }
    >
      <SettingsCard>
        <div className="px-4 py-2">
          {workspaces.map((ws) => {
            const checked = isChecked(ws.id);
            return (
              <label
                key={ws.id}
                className="flex items-center gap-3 py-1.5 text-body"
              >
                <Checkbox
                  checked={checked}
                  disabled={saving || (checked && checkedCount === 1)}
                  onCheckedChange={(value) => toggle(ws.id, value === true)}
                />
                <span className="min-w-0 truncate">{ws.name}</span>
              </label>
            );
          })}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

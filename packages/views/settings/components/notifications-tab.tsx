"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { notificationPreferenceOptions } from "@multica/core/notification-preferences/queries";
import { useUpdateNotificationPreferences } from "@multica/core/notification-preferences/mutations";
import {
  defaultNotificationPreference,
  notificationPreferenceValue,
} from "@multica/core/notification-preferences/patch";
import type { NotificationGroupKey, NotificationPreferences } from "@multica/core/types";
import { Switch } from "@multica/ui/components/ui/switch";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { BrowserNotificationSetting } from "./browser-notification-setting";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsTab,
} from "./settings-layout";

// Inbox event groups rendered in the per-event toggle list. The channel keys
// `system_notifications` and `feishu_notifications` live in their own sections.
const INBOX_GROUP_KEYS = [
  "assignments",
  "status_changes",
  "comments",
  "mentions",
  "updates",
  "agent_activity",
] as const;
type InboxGroupKey = (typeof INBOX_GROUP_KEYS)[number];

export function NotificationsTab() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const { data } = useQuery(notificationPreferenceOptions(wsId));
  const mutation = useUpdateNotificationPreferences();

  const preferences = data?.preferences ?? {};

  const handleToggle = (key: NotificationGroupKey, enabled: boolean) => {
    const value = enabled ? "all" : "muted";
    const updated: NotificationPreferences = { ...preferences, [key]: value };
    // Keep the object sparse: a key at its default value is omitted.
    if (value === defaultNotificationPreference(key)) {
      delete updated[key];
    }
    mutation.mutate(updated, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.notifications.toast_failed),
        ),
    });
  };

  const systemEnabled = preferences.system_notifications !== "muted";
  const feishuAvailable = data?.feishu?.available === true;
  const feishuEnabled =
    feishuAvailable &&
    notificationPreferenceValue(preferences, "feishu_notifications") === "all";
  const feishuReason = data?.feishu?.reason;
  const feishuDescription = feishuAvailable
    ? t(($) => $.notifications.feishu.hint)
    : feishuReason === "not_configured"
      ? t(($) => $.notifications.feishu.not_configured)
      : t(($) => $.notifications.feishu.not_linked);

  return (
    <SettingsTab title={t(($) => $.page.tabs.notifications)} scope="workspace-only">
      <SettingsSection
        title={t(($) => $.notifications.title)}
        description={t(($) => $.notifications.description)}
        anchor="inbox"
      >
        <SettingsCard>
            {INBOX_GROUP_KEYS.map((key: InboxGroupKey) => {
              const enabled = preferences[key] !== "muted";
              return (
                <SettingsRow
                  key={key}
                  anchor={key}
                  label={t(($) => $.notifications.groups[key].label)}
                  description={t(($) => $.notifications.groups[key].description)}
                >
                  <Switch
                    checked={enabled}
                    aria-label={t(($) => $.notifications.groups[key].label)}
                    onCheckedChange={(checked) => handleToggle(key, checked)}
                  />
                </SettingsRow>
              );
            })}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t(($) => $.notifications.system.title)}
      >
        <SettingsCard>
          <SettingsRow
            anchor="system"
            label={t(($) => $.notifications.system.label)}
          >
              <Switch
                checked={systemEnabled}
                aria-label={t(($) => $.notifications.system.label)}
                onCheckedChange={(checked) => handleToggle("system_notifications", checked)}
              />
          </SettingsRow>
        </SettingsCard>

        {/* Web-only: the browser permission banners require. Renders nothing on
            desktop (OS-native delivery) or where the Notification API is absent. */}
        <BrowserNotificationSetting />
      </SettingsSection>

      <SettingsSection title={t(($) => $.notifications.feishu.title)}>
        <SettingsCard>
          <SettingsRow
            anchor="feishu"
            label={t(($) => $.notifications.feishu.label)}
            description={data ? feishuDescription : undefined}
          >
            <Switch
              checked={feishuEnabled}
              disabled={!feishuAvailable}
              aria-label={t(($) => $.notifications.feishu.label)}
              onCheckedChange={(checked) => handleToggle("feishu_notifications", checked)}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </SettingsTab>
  );
}

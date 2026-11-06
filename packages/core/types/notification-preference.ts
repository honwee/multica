export type NotificationGroupKey =
  | "assignments"
  | "status_changes"
  | "comments"
  | "mentions"
  | "updates"
  | "agent_activity"
  | "system_notifications"
  | "feishu_notifications";

export type NotificationGroupValue = "all" | "muted";

export type NotificationPreferences = Partial<Record<NotificationGroupKey, NotificationGroupValue>>;

/**
 * Whether the caller can receive Feishu direct messages. `reason` is
 * "not_configured" (no Feishu login app on this deployment), "not_linked"
 * (the account has no Feishu identity), or a value from a newer server.
 */
export interface FeishuNotificationStatus {
  available: boolean;
  reason: string;
}

export interface NotificationPreferenceResponse {
  workspace_id: string;
  preferences: NotificationPreferences;
  /** Absent on servers that predate Feishu notifications. */
  feishu?: FeishuNotificationStatus;
}

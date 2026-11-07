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
 * Whether the caller can receive Feishu direct messages, which only agent
 * Feishu bots send. `reason` is "not_linked" (the account has no Feishu
 * identity), "no_agent_bot" (no agent in the workspace has a Feishu bot),
 * "not_configured" (older servers: no Feishu login app), or a value from a
 * newer server.
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

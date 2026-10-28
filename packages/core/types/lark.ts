/** A Feishu app connection with an optional agent message route.
 *
 * Wire shape mirrors `LarkInstallationResponse` in
 * `server/internal/handler/lark.go`. New fields the backend adds in the
 * future MUST default to optional so older desktop builds keep parsing
 * the response — see CLAUDE.md → API Response Compatibility. */
export interface LarkInstallation {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  app_id: string;
  tenant_key?: string | null;
  bot_open_id: string;
  installer_user_id: string;
  status: "active" | "revoked" | string;
  /** Which Lark cloud the bot lives on: "feishu" (mainland) or "lark"
   * (international). Auto-detected at install time. Optional so an older
   * desktop build parsing a newer server — or a newer build hitting a
   * server that predates the field — defaults to Feishu in the UI
   * (see CLAUDE.md → API Response Compatibility). */
  region?: "feishu" | "lark" | string;
  installed_at: string;
  created_at: string;
  updated_at: string;
}

export interface LarkInstallationBotInfo {
  installation_id: string;
  app_id: string;
  app_name: string;
  avatar_url?: string;
  bot_open_id: string;
  region: "feishu" | "lark" | string;
}

export interface ListLarkInstallationsResponse {
  installations: LarkInstallation[];
  /** Whether the deployment has the at-rest secret key configured. When
   * false the Bind button must be disabled and the panel renders an
   * empty / "ask the operator to enable Lark" state. */
  configured: boolean;
  /** Whether new installs via the device-flow scan-to-bind path can
   * complete end-to-end — i.e. the device-flow RegistrationService is
   * wired AND the real Lark HTTP APIClient (not the no-op stub) is in
   * place. When false the install entry points are hidden and the
   * panel surfaces a "coming soon" notice. Optional so older desktop
   * builds receiving a server that does not yet emit the field
   * default to `undefined`, treated as not supported. */
  install_supported?: boolean;
}

export interface ConnectLarkWorkspaceRequest {
  app_id: string;
  app_secret: string;
  tenant_key?: string;
  region?: "feishu" | "lark";
}

/** First half of the device-flow install: the server has opened a
 * registration session against accounts.feishu.cn and returned the QR
 * URL. The frontend renders `qr_code_url` as a QR (and as a clickable
 * link fallback) and starts polling `/install/{session_id}/status` at
 * the supplied cadence until success or terminal failure. */
export interface BeginLarkInstallResponse {
  session_id: string;
  qr_code_url: string;
  expires_in_seconds: number;
  poll_interval_seconds: number;
}

/** Status polling result. `status` is the discriminator. */
export interface LarkInstallStatusResponse {
  status: "pending" | "success" | "error" | string;
  /** Populated when status === "success". The frontend invalidates the
   * installations cache so the new row appears in the Settings tab. */
  installation_id?: string;
  /** Stable code on error — switch on this (NOT error_message) to pick
   * the right copy. Common values: "expired", "access_denied",
   * "lark_protocol_error", "bot_info_failed", "installation_conflict",
   * "installer_bind_failed", "internal_error". */
  error_reason?: string;
  /** Human-readable error tail for debugging; the production UI should
   * surface the copy keyed off error_reason and use this only as a
   * diagnostic tooltip. */
  error_message?: string;
}

export interface RedeemLarkBindingTokenResponse {
  workspace_id: string;
  installation_id: string;
  lark_open_id: string;
}

export interface LarkOrganizationConfig {
  installation_id: string;
  enabled: boolean;
  revision: number;
  updated_at: string;
}

export type LarkOrganizationMemberRole = "owner" | "admin" | "member";

export interface LarkOrganizationMapping {
  kind: "department" | "job_title" | string;
  external_id: string;
  external_name: string;
  member_role: LarkOrganizationMemberRole | null;
  agent_ids: string[];
}

export interface LarkOrganizationSyncChange {
  user_id: string;
  user_name: string;
  action: string;
  group_id?: string;
  group_name?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface LarkOrganizationAgentChange {
  agent_id: string;
  group_id: string;
  group_name: string;
  action: "agent_granted" | "agent_revoked" | string;
}

export interface LarkOrganizationSyncRun {
  id: string;
  workspace_id: string;
  mode: "preview" | "replay" | "apply" | string;
  status: "preview" | "completed" | "failed" | string;
  revision: number;
  plan: {
    changes: LarkOrganizationSyncChange[];
    agent_changes: LarkOrganizationAgentChange[];
    warnings: string[];
  };
  error: string;
  requested_by: string;
  replayed_from_id?: string | null;
  created_at: string;
  completed_at?: string | null;
}

export interface LarkOrganizationDepartment {
  id: string;
  name: string;
  direct_member_count: number;
  active_direct_member_count: number;
}

export interface LarkOrganizationJobTitle {
  name: string;
  member_count: number;
  active_member_count: number;
}

export interface LarkOrganizationWorkspaceMember {
  user_id: string;
  name: string;
  role: LarkOrganizationMemberRole;
  managed_role: string;
  disabled: boolean;
  linked: boolean;
  identity_conflict: boolean;
  job_title: string;
  departments: string[];
  feishu_active?: boolean | null;
}

export interface LarkOrganizationUser {
  union_id: string;
  name: string;
  job_title: string;
  departments: string[];
  active: boolean;
  workspace_member: boolean;
}

export interface LarkOrganizationCatalog {
  snapshot_at: string;
  departments: LarkOrganizationDepartment[];
  job_titles: LarkOrganizationJobTitle[];
  users: LarkOrganizationUser[];
  total_users: number;
  active_users: number;
  job_title_users: number;
  workspace_members: LarkOrganizationWorkspaceMember[];
}

export interface LarkOrganizationResponse {
  config: LarkOrganizationConfig | null;
  mappings: LarkOrganizationMapping[];
  required_scopes: string[];
  requirements: string[];
  sync_runs: LarkOrganizationSyncRun[];
  catalog?: LarkOrganizationCatalog | null;
}

export interface UpdateLarkOrganizationRequest {
  installation_id: string;
  enabled: boolean;
  mappings: LarkOrganizationMapping[];
}

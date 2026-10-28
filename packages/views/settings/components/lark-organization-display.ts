import type {
  LarkOrganizationCatalog,
  LarkOrganizationMapping,
  LarkOrganizationSyncRun,
} from "@multica/core/types";

export type OrganizationPendingAction = "save" | "preview" | "replay" | "apply" | null;
export type OrganizationChangeGroup = "add" | "change" | "remove" | "skip";

export function organizationChangeGroup(action: string): OrganizationChangeGroup {
  switch (action) {
    case "group_joined":
    case "member_restored":
    case "agent_granted":
      return "add";
    case "group_left":
    case "member_disabled":
    case "agent_revoked":
      return "remove";
    case "skipped":
      return "skip";
    default:
      return "change";
  }
}

export function organizationRoleChangeCount(run: LarkOrganizationSyncRun): number {
  return run.plan.changes.filter((change) => change.action === "role_changed").length;
}

export function organizationChangeCount(run: LarkOrganizationSyncRun): number {
  return run.plan.changes.length + run.plan.agent_changes.length;
}

export function formatOrganizationDate(value: string, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale);
}

export function formatOrganizationValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function organizationSourceSummary(
  mapping: LarkOrganizationMapping,
  catalog: LarkOrganizationCatalog | null | undefined,
): { name: string; count: number | null; duplicate: boolean; missing: boolean } {
  if (mapping.kind === "department") {
    const source = catalog?.departments.find((item) => item.id === mapping.external_id);
    const duplicates = catalog?.departments.filter((item) => item.name === source?.name).length ?? 0;
    return {
      name: mapping.external_name || source?.name || mapping.external_id,
      count: source?.direct_member_count ?? null,
      duplicate: duplicates > 1,
      missing: !!catalog && !source,
    };
  }
  if (mapping.kind === "job_title") {
    const source = catalog?.job_titles.find((item) => item.name === mapping.external_id);
    return {
      name: mapping.external_name || source?.name || mapping.external_id,
      count: source?.member_count ?? null,
      duplicate: false,
      missing: !!catalog && !source,
    };
  }
  return {
    name: mapping.external_name || mapping.external_id,
    count: null,
    duplicate: false,
    missing: false,
  };
}

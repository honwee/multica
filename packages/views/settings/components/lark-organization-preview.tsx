"use client";

import { LoaderCircle, RotateCcw } from "lucide-react";
import type {
  LarkOrganizationAgentChange,
  LarkOrganizationSyncChange,
  LarkOrganizationSyncRun,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { useLocale, useT } from "../../i18n";
import {
  formatOrganizationDate,
  formatOrganizationValue,
  organizationChangeGroup,
  organizationRoleChangeCount,
  type OrganizationChangeGroup,
  type OrganizationPendingAction,
} from "./lark-organization-display";

const groupOrder: OrganizationChangeGroup[] = ["add", "change", "remove", "skip"];

export function LarkOrganizationPreview({
  run,
  agentNames,
  canApply,
  canReplay,
  stale,
  pending,
  onReplay,
  onApply,
}: {
  run: LarkOrganizationSyncRun;
  agentNames: ReadonlyMap<string, string>;
  canApply: boolean;
  canReplay: boolean;
  stale: boolean;
  pending: OrganizationPendingAction;
  onReplay: () => void;
  onApply: () => void;
}) {
  const { t } = useT("settings");
  const locale = useLocale();
  const roleChanges = organizationRoleChangeCount(run);
  const grouped = new Map<OrganizationChangeGroup, LarkOrganizationSyncChange[]>();
  for (const change of run.plan.changes) {
    const group = organizationChangeGroup(change.action);
    grouped.set(group, [...(grouped.get(group) ?? []), change]);
  }
  const agentGrouped = new Map<OrganizationChangeGroup, LarkOrganizationAgentChange[]>();
  for (const change of run.plan.agent_changes) {
    const group = organizationChangeGroup(change.action);
    agentGrouped.set(group, [...(agentGrouped.get(group) ?? []), change]);
  }

  function groupTitle(group: OrganizationChangeGroup): string {
    switch (group) {
      case "add": return t(($) => $.lark.organization.preview_add_access);
      case "change": return t(($) => $.lark.organization.preview_adjustments);
      case "remove": return t(($) => $.lark.organization.preview_remove_access);
      case "skip": return t(($) => $.lark.organization.preview_skipped);
    }
  }

  function statusLabel(): string {
    switch (run.status) {
      case "preview": return t(($) => $.lark.organization.status_preview);
      case "completed": return t(($) => $.lark.organization.status_completed);
      case "failed": return t(($) => $.lark.organization.status_failed);
      default: return run.status;
    }
  }

  function changeContent(change: LarkOrganizationSyncChange) {
    const group = change.group_name || t(($) => $.lark.organization.unknown_group);
    switch (change.action) {
      case "group_joined":
        return { title: t(($) => $.lark.organization.action_join, { group }), detail: t(($) => $.lark.organization.membership_activate) };
      case "group_left":
        return { title: t(($) => $.lark.organization.action_leave, { group }), detail: t(($) => $.lark.organization.membership_deactivate) };
      case "role_changed":
        return { title: t(($) => $.lark.organization.action_role_changed), detail: `${formatOrganizationValue(change.before)} → ${formatOrganizationValue(change.after)}` };
      case "member_disabled":
        return { title: t(($) => $.lark.organization.action_member_disabled), detail: "" };
      case "member_restored":
        return { title: t(($) => $.lark.organization.action_member_restored), detail: "" };
      case "skipped":
        return { title: t(($) => $.lark.organization.action_skipped), detail: change.reason || "" };
      default:
        return { title: change.action, detail: change.reason || `${formatOrganizationValue(change.before)} → ${formatOrganizationValue(change.after)}` };
    }
  }

  function agentContent(change: LarkOrganizationAgentChange): string {
    const agent = agentNames.get(change.agent_id) ?? t(($) => $.lark.organization.unknown_agent);
    switch (change.action) {
      case "agent_granted": return t(($) => $.lark.organization.action_agent_granted, { agent, group: change.group_name });
      case "agent_revoked": return t(($) => $.lark.organization.action_agent_revoked, { agent, group: change.group_name });
      default: return `${agent} · ${change.action} · ${change.group_name}`;
    }
  }

  return (
    <div className="space-y-4" data-testid="lark-organization-preview">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{statusLabel()}</Badge>
            {roleChanges === 0 && <Badge variant="secondary">{t(($) => $.lark.organization.no_role_changes)}</Badge>}
            {run.plan.agent_changes.length === 0 && <Badge variant="secondary">{t(($) => $.lark.organization.no_agent_changes)}</Badge>}
          </div>
          <p className="text-caption text-muted-foreground">
            {t(($) => $.lark.organization.preview_created_at, { when: formatOrganizationDate(run.created_at, locale) })}
          </p>
        </div>
        <div className="flex gap-4 text-caption text-muted-foreground">
          <span>{t(($) => $.lark.organization.preview_member_changes)} <strong className="text-foreground">{run.plan.changes.length}</strong></span>
          <span>{t(($) => $.lark.organization.preview_agent_changes)} <strong className="text-foreground">{run.plan.agent_changes.length}</strong></span>
          <span>{t(($) => $.lark.organization.warnings)} <strong className="text-foreground">{run.plan.warnings.length}</strong></span>
        </div>
      </div>

      {run.error && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-caption text-destructive">{run.error}</p>}
      {run.plan.changes.length === 0 && run.plan.agent_changes.length === 0 && (
        <Card><CardContent><p className="text-body text-muted-foreground">{t(($) => $.lark.organization.no_changes)}</p></CardContent></Card>
      )}

      {groupOrder.map((group) => {
        const changes = grouped.get(group) ?? [];
        const agentChanges = agentGrouped.get(group) ?? [];
        if (changes.length === 0 && agentChanges.length === 0) return null;
        return (
          <section key={group} className="space-y-2">
            <h3 className="text-body font-medium">{groupTitle(group)} · {changes.length + agentChanges.length}</h3>
            <div className="divide-y rounded-md border">
              {changes.map((change, index) => {
                const content = changeContent(change);
                return (
                  <div key={`${change.user_id}-${change.action}-${change.group_id ?? ""}-${index}`} className="space-y-1 px-3 py-2.5">
                    <p className="text-body"><span className="font-medium">{change.user_name}</span> · {content.title}</p>
                    {content.detail && <p className="text-caption text-muted-foreground">{content.detail}</p>}
                    {change.reason && change.action !== "skipped" && <p className="text-caption text-muted-foreground">{change.reason}</p>}
                  </div>
                );
              })}
              {agentChanges.map((change) => (
                <div key={`${change.agent_id}-${change.group_id}-${change.action}`} className="px-3 py-2.5 text-body">
                  {agentContent(change)}
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {run.plan.warnings.length > 0 && (
        <section className="space-y-2 rounded-md bg-amber-500/10 p-3">
          <h3 className="text-body font-medium">{t(($) => $.lark.organization.warnings)}</h3>
          <ul className="list-disc space-y-1 pl-4 text-caption text-muted-foreground">
            {run.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div>
          {stale && <p className="text-caption text-muted-foreground">{t(($) => $.lark.organization.stale_preview)}</p>}
        </div>
        <div className="flex gap-2">
          {canReplay && (
            <Button variant="outline" disabled={pending !== null} aria-busy={pending === "replay" || undefined} onClick={onReplay}>
              {pending === "replay" ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
              {pending === "replay" ? t(($) => $.lark.organization.replaying) : t(($) => $.lark.organization.replay)}
            </Button>
          )}
          {canReplay && (run.mode === "preview" || run.mode === "replay") && run.status === "preview" && (
            <Button disabled={!canApply || pending !== null} onClick={onApply}>
              {t(($) => $.lark.organization.apply)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

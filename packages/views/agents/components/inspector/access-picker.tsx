"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, Loader2, Lock, Users } from "@multica/ui/icons";
import type {
  AgentInvocationTarget,
  AgentInvocationTargetInput,
  AgentPermissionMode,
  AgentVisibility,
  MemberWithUser,
} from "@multica/core/types";
import { effectiveAccessScope } from "@multica/core/agents";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { ActorAvatar } from "../../../common/actor-avatar";
import { useT } from "../../../i18n";

export type AccessChange = {
  permission_mode: AgentPermissionMode;
  invocation_targets: AgentInvocationTargetInput[];
};

type AccessScope = "private" | "workspace" | "members";

/** An organization group (department, job title, …) an agent can be granted
 *  to. Comes from the applied Feishu organization sync. */
export type AccessTeam = { id: string; name: string };


function selectedTargetIds(
  targets: AgentInvocationTarget[] | undefined | null,
  type: "member" | "team",
): string[] {
  return (targets ?? [])
    .filter(
      (target) => target.target_type === type && target.target_id !== null,
    )
    .map((target) => target.target_id as string);
}

/**
 * Draft-first access editor. Visibility changes are security-sensitive, so
 * choosing a scope only updates the draft; nothing is persisted until the
 * owner explicitly saves the complete selection.
 */
export function AccessPicker({
  permissionMode,
  invocationTargets,
  visibility: _visibility,
  members,
  teams = [],
  ownerId,
  canEdit = true,
  hasComposioAllowlist = false,
  onDirtyChange,
  onReadyChange,
  onChange,
  hideFooter = false,
}: {
  permissionMode: AgentPermissionMode;
  invocationTargets: AgentInvocationTarget[] | undefined;
  visibility: AgentVisibility;
  members: MemberWithUser[];
  /** Organization groups offered next to people. Team ids already granted
   *  but absent from this list are preserved on save, not shown. */
  teams?: AccessTeam[];
  ownerId?: string | null;
  canEdit?: boolean;
  hasComposioAllowlist?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  /** Notified when the draft becomes committable / non-committable.
   *  The optional second argument is the current AccessChange when the draft
   *  is ready, so the parent can store it for immediate use (e.g. the bulk
   *  dialog's Apply button). */
  onReadyChange?: (ready: boolean, change?: AccessChange) => void;
  onChange?: (next: AccessChange) => Promise<void> | void;
  /** When true, suppress the bottom Save footer — the parent dialog owns
   *  the apply trigger (e.g. the bulk "Set access scope" dialog). */
  hideFooter?: boolean;
}) {
  const { t } = useT("agents");
  const { t: tc } = useT("common");
  // Centralized derivation (MUL-3963): map canonical scope to picker's
  // local draft key (private / workspace / members).
  const canonical = effectiveAccessScope(permissionMode, invocationTargets);
  const persistedPrivate = permissionMode === "private";
  const persistedWorkspace = canonical === "workspace";
  const persistedScope: AccessScope = persistedPrivate
    ? "private"
    : persistedWorkspace
      ? "workspace"
      : "members";
  const persistedMembers = useMemo(
    () => selectedTargetIds(invocationTargets, "member"),
    [invocationTargets],
  );
  const persistedTeams = useMemo(
    () => selectedTargetIds(invocationTargets, "team"),
    [invocationTargets],
  );

  const [draftScope, setDraftScope] = useState<AccessScope>(persistedScope);
  const [draftMembers, setDraftMembers] = useState(persistedMembers);
  const [draftTeams, setDraftTeams] = useState(persistedTeams);
  const [saving, setSaving] = useState(false);
  /** Tracks whether the user has explicitly selected a scope (clicked any
   *  radio). Once true, the picker considers the draft "ready" even if the
   *  selection matches the persisted default — applying the default to a
   *  bulk selection is still a valid action. */
  const [hasInteracted, setHasInteracted] = useState(false);

  /** Wrapper that marks the picker as interacted and updates the draft scope. */
  const selectDraftScope = (scope: AccessScope) => {
    setHasInteracted(true);
    setDraftScope(scope);
  };

  // Only reset the draft when the PERSISTED values actually change by value,
  // not by reference. A prop like invocationTargets={[]} creates a new array
  // on every parent render, which would otherwise cause this effect to fire
  // on every render and reset the user's in-progress edits.
  const prevPersistedScopeRef = useRef(persistedScope);
  const prevPersistedMembersRef = useRef(persistedMembers);
  const prevPersistedTeamsRef = useRef(persistedTeams);
  useEffect(() => {
    const scopeChanged = persistedScope !== prevPersistedScopeRef.current;
    const membersChanged = !sameIds(persistedMembers, prevPersistedMembersRef.current);
    const teamsChanged = !sameIds(persistedTeams, prevPersistedTeamsRef.current);
    if (scopeChanged || membersChanged || teamsChanged) {
      setDraftScope(persistedScope);
      setDraftMembers(persistedMembers);
      setDraftTeams(persistedTeams);
      prevPersistedScopeRef.current = persistedScope;
      prevPersistedMembersRef.current = persistedMembers;
      prevPersistedTeamsRef.current = persistedTeams;
    }
  }, [persistedScope, persistedMembers, persistedTeams]);

  const editableMembers = ownerId
    ? members.filter((member) => member.user_id !== ownerId)
    : members;

  const sameMembers = sameIdSet(draftMembers, persistedMembers);
  const sameTeams = sameIdSet(draftTeams, persistedTeams);
  const dirty =
    draftScope !== persistedScope ||
    (draftScope === "members" && (!sameMembers || !sameTeams));
  const hasMemberTarget = draftMembers.length > 0 || draftTeams.length > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  /** The change the current draft would commit, or null when the draft is not
   *  committable (specific-people with zero targets). Memoized by draft value:
   *  a parent that stores this in state re-renders the picker with an identical
   *  reference, so the notify effect below stays quiet. */
  const draftChange = useMemo<AccessChange | null>(() => {
    if (draftScope === "private") {
      return { permission_mode: "private", invocation_targets: [] };
    }
    const targets: AgentInvocationTargetInput[] = [];
    if (draftScope === "workspace") {
      targets.push({ target_type: "workspace" });
    }
    if (draftScope === "members") {
      if (draftMembers.length === 0 && draftTeams.length === 0) return null;
      for (const id of draftMembers) {
        targets.push({ target_type: "member", target_id: id });
      }
      for (const id of draftTeams) {
        targets.push({ target_type: "team", target_id: id });
      }
    }
    return { permission_mode: "public_to", invocation_targets: targets };
  }, [draftScope, draftMembers, draftTeams]);

  /** Ready once the user has explicitly selected a scope (hasInteracted) AND
   *  the draft is committable. Does NOT require the draft to differ from the
   *  persisted state — applying the default scope to a bulk selection is a
   *  valid action. */
  const readyChange = hasInteracted ? draftChange : null;

  // Notify on value change, never on render. `onReadyChange` must be stable in
  // the caller; combined with the memoized `readyChange` that keeps a parent
  // storing the change in state from re-triggering this effect. Deliberately no
  // cleanup: clearing the parent whenever a dependency changes is what turned
  // this into an update loop. The parent owns resetting its own state.
  useEffect(() => {
    onReadyChange?.(readyChange !== null, readyChange ?? undefined);
  }, [readyChange, onReadyChange]);

  const toggleMember = (userId: string, checked: boolean) => {
    setDraftMembers((current) => toggleId(current, userId, checked));
  };
  const toggleTeam = (teamId: string, checked: boolean) => {
    setDraftTeams((current) => toggleId(current, teamId, checked));
  };

  const save = async () => {
    if (!onChange || saving || !draftChange) return;
    setSaving(true);
    try {
      await onChange(draftChange);
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit) {
    const grantLabels = [
      persistedMembers.length > 0
        ? t(($) => $.access.trigger_members_count, { count: persistedMembers.length })
        : "",
      persistedTeams.length > 0
        ? t(($) => $.access.trigger_teams_count, { count: persistedTeams.length })
        : "",
    ].filter(Boolean);
    const summaryLabel = persistedPrivate
      ? t(($) => $.access.trigger_private)
      : persistedWorkspace
        ? t(($) => $.access.trigger_workspace)
        : grantLabels.length > 0
          ? grantLabels.join(" · ")
          : t(($) => $.access.trigger_members_empty);

    return (
      <div
        className="flex items-start gap-3 px-4 py-4"
        aria-label={t(($) => $.access.owner_only_readonly)}
        data-testid="access-readonly"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Lock className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-body font-medium">{summaryLabel}</p>
          <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
            {t(($) => $.access.owner_only_readonly)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <fieldset>
      <legend className="sr-only">{t(($) => $.access.tooltip)}</legend>

      <div className="divide-y divide-surface-border">
        <AccessChoice
          name="agent-access-mode"
          value="private"
          icon={Lock}
          title={t(($) => $.access.private_title)}
          description={t(($) => $.access.private_desc)}
          selected={draftScope === "private"}
          onSelect={() => selectDraftScope("private")}
        />
        <AccessChoice
          name="agent-access-mode"
          value="workspace"
          icon={Globe}
          title={t(($) => $.access.workspace_title)}
          description={t(($) => $.access.workspace_desc)}
          selected={draftScope === "workspace"}
          onSelect={() => selectDraftScope("workspace")}
        />
        <AccessChoice
          name="agent-access-mode"
          value="members"
          icon={Users}
          title={t(($) => $.access.members_title)}
          description={t(($) => $.access.members_desc)}
          selected={draftScope === "members"}
          onSelect={() => selectDraftScope("members")}
        />
      </div>

      {draftScope === "members" ? (
        <div className="border-t border-surface-border bg-muted/20 px-4 py-5 sm:px-6">
          <div>
            {editableMembers.length === 0 ? (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.access.members_empty)}
              </p>
            ) : (
              <div className="max-h-64 divide-y divide-surface-border overflow-y-auto rounded-lg border bg-background overscroll-contain">
                {editableMembers.map((member) => {
                  const id = `agent-access-member-${member.user_id}`;
                  return (
                    <div
                      key={member.user_id}
                      className="flex items-center gap-3 px-3 py-3 hover:bg-surface-hover"
                    >
                      <Checkbox
                        id={id}
                        checked={draftMembers.includes(member.user_id)}
                        onCheckedChange={(value) =>
                          toggleMember(member.user_id, value === true)
                        }
                      />
                      <label
                        htmlFor={id}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                      >
                        <ActorAvatar
                          actorType="member"
                          actorId={member.user_id}
                          size="sm"
                        />
                        <span className="min-w-0 flex-1 truncate text-body">
                          {member.name}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {teams.length > 0 ? (
            <div className="mt-4" data-testid="access-teams">
              <p className="text-caption font-medium">{t(($) => $.access.teams_group)}</p>
              <p className="mt-0.5 mb-2 text-caption text-muted-foreground">
                {t(($) => $.access.teams_hint)}
              </p>
              <div className="max-h-64 divide-y divide-surface-border overflow-y-auto rounded-lg border bg-background overscroll-contain">
                {teams.map((team) => {
                  const id = `agent-access-team-${team.id}`;
                  return (
                    <div
                      key={team.id}
                      className="flex items-center gap-3 px-3 py-3 hover:bg-surface-hover"
                    >
                      <Checkbox
                        id={id}
                        checked={draftTeams.includes(team.id)}
                        onCheckedChange={(value) => toggleTeam(team.id, value === true)}
                      />
                      <label
                        htmlFor={id}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          <Users className="size-3.5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-body">{team.name}</span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {!hasMemberTarget ? (
            <p className="mt-3 text-caption text-destructive" role="alert">
              {t(($) => $.access.shared_target_required)}
            </p>
          ) : null}
        </div>
      ) : null}

      {hasComposioAllowlist && persistedPrivate && draftScope !== "private" ? (
        <div className="border-t border-surface-border bg-muted/20 px-4 py-4 sm:px-6">
          <p className="border-l-2 border-warning pl-3 text-caption leading-5 text-muted-foreground">
            {t(($) => $.access.composio_switch_hint)}
          </p>
        </div>
      ) : null}

      {hideFooter ? null : (
        <div className="flex justify-end border-t border-surface-border px-4 py-3.5">
          <Button
            type="button"
            onClick={() => void save()}
            disabled={
              !onChange || !dirty || saving || (draftScope === "members" && !hasMemberTarget)
            }
          >
            {saving ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {tc(($) => $.save)}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameIdSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function toggleId(current: string[], id: string, checked: boolean): string[] {
  const next = new Set(current);
  if (checked) next.add(id);
  else next.delete(id);
  return Array.from(next);
}

function AccessChoice({
  name,
  value,
  icon: Icon,
  title,
  description,
  selected,
  onSelect,
}: {
  name: string;
  value: string;
  icon: typeof Lock;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="flex min-h-16 cursor-pointer items-start gap-3 px-4 py-3.5 transition-colors hover:bg-surface-hover">
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        onChange={onSelect}
        className="mt-2 size-4 shrink-0 accent-foreground"
      />
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium">{title}</span>
        <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

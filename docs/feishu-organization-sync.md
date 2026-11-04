# Feishu organization permission sync

Multica maps Feishu departments and job titles to workspace roles and agent
access. The feature is opt-in per workspace. Saving a configuration never
changes member or agent access by itself: an owner or admin must fetch a
preview, review the changes, and explicitly apply it. Only the agent owner may
save or apply a mapping for that agent.

## Feishu application checklist

Use an active Feishu installation that belongs to the workspace being
configured. In the Feishu developer console for that same app:

1. Grant `contact:department:readonly`, `contact:user:readonly`,
   `contact:user.email:readonly`, and `is_resigned:read`. The last two are
   field-level permissions used for identity fallback and explicit offboarding;
   job title is read from the Contact v3 user record.
2. Publish a new app version after changing scopes, then have the tenant admin
   approve it if the tenant requires approval.
3. Set the app's contact visibility scope to every department and user taking
   part in synchronization. Restricted visibility is not treated as an empty
   organization; an API or permission error produces a failed preview instead.
4. Keep the app credential and Bot installation active. Multica uses the
   existing encrypted installation credential and never returns it through the
   organization API.

The sync calls the department-children and direct-department-user Contact v3
APIs, following every page. It reads open/union IDs, email, department
membership, job title, and resignation state only. It does not write to Feishu
or change its scopes, roles, visibility, or event subscriptions. See the
[Feishu direct-department-user API](https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department?lang=zh-CN)
and [scope list](https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list?lang=zh-CN).

## Mapping and conflict rules

- Department IDs use `open_department_id`; job-title mappings exactly match the
  Feishu `job_title` value. Unknown departments, job titles, and roles grant
  nothing and appear as preview warnings.
- A member belonging to several mapped groups receives the highest mapped
  workspace role: `owner > admin > member`. Only a workspace owner may save an
  owner-role mapping.
- Explicit role mappings may elevate a member after preview approval. A higher
  manually assigned role is not demoted unless its previous role was already
  Feishu-managed. Editing a role manually clears its Feishu-managed marker.
- Agent mappings plan `team` invocation-target additions or removals; only an
  apply writes them. Configured groups are separate from applied active groups,
  so saving a new or removed mapping cannot change access before preview.
  Active group membership controls agent visibility, assignment, direct
  invocation, A2A originator checks, and durable triggers. Assignment
  intentionally uses the existing invocation gate because assigning an agent
  can start a run.
- Existing users are matched by union ID, Feishu OAuth open ID, channel-binding
  open ID, then exact lowercase email, in that order. Ambiguous identities are
  skipped and reported. Synchronization does not provision new users.
- Transferring departments or changing job title recalculates groups from the
  current snapshot. Removed memberships become inactive; historical rows and
  invocation targets remain auditable.

## Preview, apply, failure, and replay

A preview is a complete snapshot plus a deterministic change plan. Applying
requires the same configuration revision and recalculates the plan against the
current members and mappings, so an old plan cannot reapply stale changes.
Applying the same preview again is idempotent.

Users whom Feishu explicitly marks resigned are disabled rather than deleted.
A tracked user missing from a snapshot produces a verification warning and no
automatic change: restricted visibility and an unexpectedly empty response
cannot turn into a mass offboarding. Verify that user's status and restore full
contact visibility before taking action. Disabled members fail the same
membership checks as removed members, while their user, agent, issue, task,
comment, and channel history is preserved. Active ownership is protected: a
plan that would leave no active owner skips that demotion or disable action. A
user who returns as active is restored only from the current snapshot and
mappings.

Transport, permission, pagination, and planning failures create a failed sync
run with an error and no applicable plan. Replay uses the stored snapshot,
recalculates against current state, and creates a new preview; it neither calls
Feishu nor directly repeats old writes. Fetch a fresh preview before relying on
replay for production offboarding.

This version provides operator-triggered complete synchronization, not a
scheduler. For incremental rollout, Feishu user/department change events should
only invalidate the workspace and enqueue a fresh complete snapshot. Events
must not be treated as authoritative permission payloads: the complete fetch
closes missed-event and reordering gaps, while missing-member warnings surface
visibility problems without applying them. Keep manual replay as recovery and
audit history as the watermark.

## Production review, backup, and rollback

No production operation is part of the code change. A human operator must:

1. Review migrations 594–604 and confirm the target database and deployment
   environment. The migration runner executes concurrent-index files outside an
   explicit transaction; do not wrap them in one.
2. Backup the target database and verify restore access before applying the
   migration. For example, using the deployment's existing database environment
   and a private backup location:

   ```bash
   pg_dump "$DATABASE_URL" --format=custom --file=multica-before-lum-18.dump
   ```

   Do not commit the dump or expose its credentials. For a point-in-time
   recovery environment, restore it according to the deployment's normal
   database recovery procedure before any destructive rollback.
3. Apply migrations with `make migrate-up` in the intended environment, then
   run backend regression checks. Existing members, roles, agents, tasks, and
   bindings are not backfilled or rewritten by these migrations.
4. Configure one non-production workspace first, grant the Feishu checklist
   above, save mappings, inspect preview warnings and every change, then apply.
   Confirm unknown groups remain denied and test one transfer and one
   resignation with a non-owner test member.
5. Roll back application configuration by disabling organization sync; this
   does not apply a new role change. To undo applied access, save the corrected
   mapping and apply a fresh reviewed preview. Historical sync runs remain for
   audit.

A schema rollback is only safe after restoring or reviewing all data written
since deployment. Rolling back migrations 604 down through 594 drops the new
organization configuration, memberships, and sync audit tables and removes the
member disable/managed-role columns. `make migrate-down` rolls back all applied
migrations in reverse order, not just this feature; do not run it against a
shared production database without an approved full rollback plan. Prefer a
forward fix, or restore the verified backup into a separate recovery database
and follow the normal disaster-recovery cutover.

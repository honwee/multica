"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { larkKeys, larkOrganizationOptions } from "@multica/core/lark/queries";
import type {
  Agent,
  LarkInstallation,
  LarkOrganizationMapping as LarkOrganizationMappingValue,
  LarkOrganizationMemberRole,
  LarkOrganizationSyncRun,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Switch } from "@multica/ui/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { useT } from "../../i18n";

type PendingAction = "save" | "preview" | "replay" | "apply" | null;

export function LarkOrganizationMapping({
  installations,
  canManage,
}: {
  installations: LarkInstallation[];
  canManage: boolean;
}) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const id = useId();
  const { data, isLoading, isError } = useQuery(larkOrganizationOptions(wsId));
  const { data: agents = [] } = useQuery({
    queryKey: ["workspaces", wsId, "agents"] as const,
    queryFn: () => api.listAgents({ workspace_id: wsId, include_archived: true }),
    enabled: !!wsId,
  });
  const activeInstallations = useMemo(
    () => installations.filter((installation) => installation.status === "active"),
    [installations],
  );
  const [installationId, setInstallationId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [mappings, setMappings] = useState<LarkOrganizationMappingValue[]>([]);
  const [run, setRun] = useState<LarkOrganizationSyncRun | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [applyOpen, setApplyOpen] = useState(false);

  useEffect(() => {
    const config = data?.config;
    const configuredInstallationIsActive = activeInstallations.some(
      (installation) => installation.id === config?.installation_id,
    );
    setInstallationId(
      config && configuredInstallationIsActive
        ? config.installation_id
        : activeInstallations[0]?.id ?? "",
    );
    setEnabled(config?.enabled ?? false);
    setMappings(
      (data?.mappings ?? []).map((mapping) => ({
        ...mapping,
        agent_ids: [...mapping.agent_ids],
      })),
    );
  }, [data, activeInstallations]);

  const latestStoredRun = useMemo(
    () =>
      [...(data?.sync_runs ?? [])]
        .filter((candidate) => candidate.mode === "preview" || candidate.mode === "replay")
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null,
    [data?.sync_runs],
  );
  const displayedRun = run ?? latestStoredRun;
  const config = data?.config ?? null;
  const draftSignature = JSON.stringify({
    installation_id: installationId,
    enabled,
    mappings,
  });
  const savedSignature = config
    ? JSON.stringify({
        installation_id: config.installation_id,
        enabled: config.enabled,
        mappings: data?.mappings ?? [],
      })
    : null;
  const dirty = !savedSignature || draftSignature !== savedSignature;
  const missingExternalId = mappings.some((mapping) => !mapping.external_id.trim());
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const installationName = (installation: LarkInstallation) =>
    agentNames.get(installation.agent_id) ?? t(($) => $.lark.organization.unknown_agent);
  const selectedInstallation = installations.find(
    (installation) => installation.id === config?.installation_id,
  );
  const canApply = Boolean(
    canManage &&
      displayedRun &&
      (displayedRun.mode === "preview" || displayedRun.mode === "replay") &&
      displayedRun.status === "preview" &&
      displayedRun.revision === config?.revision,
  );
  const canReplay = Boolean(
    canManage &&
      displayedRun &&
      (displayedRun.mode === "preview" || displayedRun.mode === "replay"),
  );

  async function invalidateOrganization() {
    await queryClient.invalidateQueries({ queryKey: larkKeys.organization(wsId) });
  }

  function updateMapping(index: number, next: LarkOrganizationMappingValue) {
    setMappings((current) => current.map((mapping, i) => (i === index ? next : mapping)));
  }

  async function save() {
    if (!installationId || missingExternalId || pending) return;
    const nextMappings = mappings.map((mapping) => ({
      ...mapping,
      external_id: mapping.external_id.trim(),
      external_name: mapping.external_name.trim(),
    }));
    setPending("save");
    try {
      await api.updateLarkOrganization(wsId, {
        installation_id: installationId,
        enabled,
        mappings: nextMappings,
      });
      setMappings(nextMappings);
      setRun(null);
      await invalidateOrganization();
      toast.success(t(($) => $.lark.organization.saved));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.lark.organization.save_failed),
      );
    } finally {
      setPending(null);
    }
  }

  async function preview() {
    if (dirty || pending) return;
    setPending("preview");
    try {
      const nextRun = await api.previewLarkOrganization(wsId);
      setRun(nextRun);
      await invalidateOrganization();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.lark.organization.preview_failed),
      );
    } finally {
      setPending(null);
    }
  }

  async function replay() {
    if (!displayedRun || pending) return;
    setPending("replay");
    try {
      const nextRun = await api.replayLarkOrganizationSync(wsId, displayedRun.id);
      setRun(nextRun);
      await invalidateOrganization();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.lark.organization.replay_failed),
      );
    } finally {
      setPending(null);
    }
  }

  async function apply() {
    if (!displayedRun || !canApply || pending) return;
    setPending("apply");
    try {
      const nextRun = await api.applyLarkOrganizationSync(wsId, displayedRun.id);
      setRun(nextRun);
      await invalidateOrganization();
      setApplyOpen(false);
      toast.success(t(($) => $.lark.organization.applied));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.lark.organization.apply_failed),
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby={`${id}-title`}>
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-body font-semibold">
          {t(($) => $.lark.organization.title)}
        </h2>
        <p className="text-caption text-muted-foreground">
          {t(($) => $.lark.organization.description)}
        </p>
      </div>
      {!canManage && (
        <p className="text-caption text-muted-foreground">
          {t(($) => $.lark.organization.read_only)}
        </p>
      )}
      <Card>
        <CardContent className="space-y-5">
          {isLoading ? (
            <p className="text-body text-muted-foreground">
              {t(($) => $.lark.organization.loading)}
            </p>
          ) : isError ? (
            <p role="alert" className="text-body text-destructive">
              {t(($) => $.lark.organization.load_error)}
            </p>
          ) : (
            <>
              {canManage ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-source`}>
                        {t(($) => $.lark.organization.source)}
                      </Label>
                      {activeInstallations.length > 0 ? (
                        <Select
                          items={activeInstallations.map((installation) => ({
                            value: installation.id,
                            label: installationName(installation),
                          }))}
                          value={installationId}
                          onValueChange={(value) => setInstallationId(value ?? "")}
                        >
                          <SelectTrigger id={`${id}-source`} className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {activeInstallations.map((installation) => (
                              <SelectItem key={installation.id} value={installation.id}>
                                {installationName(installation)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-caption text-muted-foreground">
                          {t(($) => $.lark.organization.no_active_installations)}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`${id}-enabled`}>
                        {t(($) => $.lark.organization.enabled)}
                      </Label>
                      <Switch
                        id={`${id}-enabled`}
                        checked={enabled}
                        onCheckedChange={(checked) => setEnabled(checked === true)}
                        disabled={pending !== null}
                      />
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-body font-medium">
                        {t(($) => $.lark.organization.mappings)}
                      </h3>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending !== null}
                        onClick={() =>
                          setMappings((current) => [
                            ...current,
                            {
                              kind: "department",
                              external_id: "",
                              external_name: "",
                              member_role: null,
                              agent_ids: [],
                            },
                          ])
                        }
                      >
                        <Plus />
                        {t(($) => $.lark.organization.add_mapping)}
                      </Button>
                    </div>
                    {mappings.length === 0 ? (
                      <p className="text-caption text-muted-foreground">
                        {t(($) => $.lark.organization.no_mappings)}
                      </p>
                    ) : (
                      mappings.map((mapping, index) => (
                        <MappingEditor
                          key={index}
                          idPrefix={`${id}-mapping-${index}`}
                          mapping={mapping}
                          agents={agents}
                          disabled={pending !== null}
                          onChange={(next) => updateMapping(index, next)}
                          onRemove={() =>
                            setMappings((current) => current.filter((_, i) => i !== index))
                          }
                        />
                      ))
                    )}
                    {missingExternalId && (
                      <p className="text-caption text-muted-foreground">
                        {t(($) => $.lark.organization.external_id_required)}
                      </p>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        !dirty || !installationId || missingExternalId || pending !== null
                      }
                      aria-busy={pending === "save" || undefined}
                      onClick={save}
                    >
                      {pending === "save" && <LoaderCircle className="animate-spin" />}
                      {pending === "save"
                        ? t(($) => $.lark.organization.saving)
                        : t(($) => $.lark.organization.save)}
                    </Button>
                  </div>
                </>
              ) : (
                <ReadOnlyConfiguration
                  installationName={
                    selectedInstallation ? installationName(selectedInstallation) : null
                  }
                  enabled={config?.enabled ?? false}
                  mappings={data?.mappings ?? []}
                  agents={agents}
                />
              )}
              {(data?.required_scopes.length || data?.requirements.length) ? (
                <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                  {!!data?.required_scopes.length && (
                    <div className="space-y-2">
                      <h3 className="text-caption font-medium">
                        {t(($) => $.lark.organization.required_scopes)}
                      </h3>
                      <div className="flex flex-wrap gap-1.5">
                        {data.required_scopes.map((scope) => (
                          <code
                            key={scope}
                            className="rounded-xs bg-muted px-1.5 py-0.5 text-micro break-all"
                          >
                            {scope}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}
                  {!!data?.requirements.length && (
                    <div className="space-y-2">
                      <h3 className="text-caption font-medium">
                        {t(($) => $.lark.organization.requirements)}
                      </h3>
                      <ul className="list-disc space-y-1 pl-4 text-caption text-muted-foreground">
                        {data.requirements.map((requirement) => (
                          <li key={requirement}>
                            <OrganizationRequirement value={requirement} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {!isLoading && !isError && (
        <Card>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h3 className="text-body font-medium">
                  {t(($) => $.lark.organization.preview_title)}
                </h3>
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.lark.organization.preview_description)}
                </p>
              </div>
              {canManage && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={dirty || !config || pending !== null}
                  aria-busy={pending === "preview" || undefined}
                  onClick={preview}
                >
                  {pending === "preview" && <LoaderCircle className="animate-spin" />}
                  {pending === "preview"
                    ? t(($) => $.lark.organization.previewing)
                    : t(($) => $.lark.organization.preview)}
                </Button>
              )}
            </div>
            {canManage && dirty && (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.lark.organization.preview_save_first)}
              </p>
            )}
            {displayedRun ? (
              <>
                <PreviewDetails run={displayedRun} agentNames={agentNames} />
                {displayedRun.revision !== config?.revision &&
                  displayedRun.status === "preview" && (
                    <p className="text-caption text-muted-foreground">
                      {t(($) => $.lark.organization.stale_preview)}
                    </p>
                  )}
                {canManage && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {canReplay && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending !== null}
                        aria-busy={pending === "replay" || undefined}
                        onClick={replay}
                      >
                        {pending === "replay" && <LoaderCircle className="animate-spin" />}
                        {pending === "replay"
                          ? t(($) => $.lark.organization.replaying)
                          : t(($) => $.lark.organization.replay)}
                      </Button>
                    )}
                    {(displayedRun.mode === "preview" || displayedRun.mode === "replay") &&
                      displayedRun.status === "preview" && (
                        <Button
                          type="button"
                          size="sm"
                          disabled={!canApply || pending !== null}
                          onClick={() => setApplyOpen(true)}
                        >
                          {t(($) => $.lark.organization.apply)}
                        </Button>
                      )}
                  </div>
                )}
              </>
            ) : (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.lark.organization.no_preview)}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <AlertDialog
          open={applyOpen}
          onOpenChange={(open) => {
            if (!open && pending !== "apply") setApplyOpen(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t(($) => $.lark.organization.apply_confirm_title)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t(($) => $.lark.organization.apply_confirm_description)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending === "apply"}>
                {t(($) => $.lark.organization.apply_confirm_cancel)}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={!canApply || pending === "apply"}
                aria-busy={pending === "apply" || undefined}
                onClick={(event) => {
                  event.preventDefault();
                  void apply();
                }}
              >
                {pending === "apply" && <LoaderCircle className="animate-spin" />}
                {pending === "apply"
                  ? t(($) => $.lark.organization.applying)
                  : t(($) => $.lark.organization.apply)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  );
}

function MappingEditor({
  idPrefix,
  mapping,
  agents,
  disabled,
  onChange,
  onRemove,
}: {
  idPrefix: string;
  mapping: LarkOrganizationMappingValue;
  agents: Agent[];
  disabled: boolean;
  onChange: (mapping: LarkOrganizationMappingValue) => void;
  onRemove: () => void;
}) {
  const { t } = useT("settings");
  const knownAgentIds = new Set(agents.map((agent) => agent.id));
  const agentOptions = [
    ...agents.map((agent) => ({ id: agent.id, name: agent.name })),
    ...mapping.agent_ids
      .filter((agentId) => !knownAgentIds.has(agentId))
      .map((agentId) => ({
        id: agentId,
        name: t(($) => $.lark.organization.unknown_agent),
      })),
  ];
  const roleItems = [
    { value: "none", label: t(($) => $.lark.organization.no_member_role) },
    { value: "owner", label: t(($) => $.lark.organization.role_owner) },
    { value: "admin", label: t(($) => $.lark.organization.role_admin) },
    { value: "member", label: t(($) => $.lark.organization.role_member) },
  ];
  const kindItems = [
    { value: "department", label: t(($) => $.lark.organization.department) },
    { value: "job_title", label: t(($) => $.lark.organization.job_title) },
    ...(mapping.kind === "department" || mapping.kind === "job_title"
      ? []
      : [{ value: mapping.kind, label: mapping.kind }]),
  ];

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-kind`}>
              {t(($) => $.lark.organization.mapping_kind)}
            </Label>
            <Select
              items={kindItems}
              value={mapping.kind}
              onValueChange={(value) => {
                if (value) onChange({ ...mapping, kind: value });
              }}
            >
              <SelectTrigger id={`${idPrefix}-kind`} className="w-full" disabled={disabled}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kindItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-role`}>
              {t(($) => $.lark.organization.member_role)}
            </Label>
            <Select
              items={roleItems}
              value={mapping.member_role ?? "none"}
              onValueChange={(value) =>
                onChange({
                  ...mapping,
                  member_role:
                    value === "none" ? null : (value as LarkOrganizationMemberRole),
                })
              }
            >
              <SelectTrigger id={`${idPrefix}-role`} className="w-full" disabled={disabled}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={t(($) => $.lark.organization.remove_mapping_named, {
            name: mapping.external_name || mapping.external_id || mapping.kind,
          })}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-name`}>
            {t(($) => $.lark.organization.external_name)}
          </Label>
          <Input
            id={`${idPrefix}-name`}
            value={mapping.external_name}
            disabled={disabled}
            onChange={(event) => onChange({ ...mapping, external_name: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-external-id`}>
            {t(($) => $.lark.organization.external_id)}
          </Label>
          <Input
            id={`${idPrefix}-external-id`}
            value={mapping.external_id}
            disabled={disabled}
            placeholder={t(($) => $.lark.organization.external_id_placeholder)}
            onChange={(event) => onChange({ ...mapping, external_id: event.target.value })}
          />
        </div>
      </div>
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-caption font-medium">
          {t(($) => $.lark.organization.agents)}
        </legend>
        {agentOptions.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.lark.organization.no_agents)}
          </p>
        ) : (
          <div className="grid max-h-36 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {agentOptions.map((agent) => {
              const checked = mapping.agent_ids.includes(agent.id);
              return (
                <div key={agent.id} className="flex min-w-0 items-center gap-2">
                  <Checkbox
                    id={`${idPrefix}-agent-${agent.id}`}
                    checked={checked}
                    onCheckedChange={(nextChecked) =>
                      onChange({
                        ...mapping,
                        agent_ids:
                          nextChecked === true
                            ? [...mapping.agent_ids, agent.id]
                            : mapping.agent_ids.filter((agentId) => agentId !== agent.id),
                      })
                    }
                  />
                  <Label
                    htmlFor={`${idPrefix}-agent-${agent.id}`}
                    className="min-w-0 truncate font-normal"
                  >
                    {agent.name}
                  </Label>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>
    </div>
  );
}

function ReadOnlyConfiguration({
  installationName,
  enabled,
  mappings,
  agents,
}: {
  installationName: string | null;
  enabled: boolean;
  mappings: LarkOrganizationMappingValue[];
  agents: Agent[];
}) {
  const { t } = useT("settings");
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const roleLabels: Record<LarkOrganizationMemberRole, string> = {
    owner: t(($) => $.lark.organization.role_owner),
    admin: t(($) => $.lark.organization.role_admin),
    member: t(($) => $.lark.organization.role_member),
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <h3 className="text-caption font-medium">
            {t(($) => $.lark.organization.source)}
          </h3>
          <p className="mt-1 text-body text-muted-foreground">
            {installationName ?? t(($) => $.lark.organization.no_active_installations)}
          </p>
        </div>
        <div>
          <h3 className="text-caption font-medium">
            {t(($) => $.lark.organization.enabled)}
          </h3>
          <p className="mt-1 text-body text-muted-foreground">
            {enabled
              ? t(($) => $.lark.organization.enabled_yes)
              : t(($) => $.lark.organization.enabled_no)}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <h3 className="text-caption font-medium">
          {t(($) => $.lark.organization.mappings)}
        </h3>
        {mappings.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.lark.organization.no_mappings)}
          </p>
        ) : (
          mappings.map((mapping, index) => (
            <div
              key={`${mapping.kind}-${mapping.external_id}-${index}`}
              className="rounded-md border px-3 py-2 text-caption"
            >
              <p className="font-medium break-words">
                {mapping.external_name || mapping.external_id}
              </p>
              <p className="mt-1 text-muted-foreground break-all">{mapping.external_id}</p>
              <p className="mt-1 text-muted-foreground">
                {mapping.kind === "department"
                  ? t(($) => $.lark.organization.department)
                  : mapping.kind === "job_title"
                    ? t(($) => $.lark.organization.job_title)
                    : mapping.kind}
                {" · "}
                {mapping.member_role
                  ? roleLabels[mapping.member_role]
                  : t(($) => $.lark.organization.no_member_role)}
              </p>
              <p className="mt-1 text-muted-foreground break-words">
                {t(($) => $.lark.organization.agents)}:{" "}
                {mapping.agent_ids.length
                  ? mapping.agent_ids
                      .map(
                        (agentId) =>
                          agentNames.get(agentId) ??
                          t(($) => $.lark.organization.unknown_agent),
                      )
                      .join(", ")
                  : t(($) => $.lark.organization.no_agents)}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OrganizationRequirement({ value }: { value: string }) {
  const { t } = useT("settings");
  switch (value) {
    case "Grant the required scopes and publish a new app version.":
      return <>{t(($) => $.lark.organization.requirement_publish)}</>;
    case "Include every required department and user in the app's contact visibility scope.":
      return <>{t(($) => $.lark.organization.requirement_visibility)}</>;
    default:
      return <>{value}</>;
  }
}

function PreviewDetails({
  run,
  agentNames,
}: {
  run: LarkOrganizationSyncRun;
  agentNames: ReadonlyMap<string, string>;
}) {
  const { t } = useT("settings");
  return (
    <div className="space-y-3" data-testid="lark-organization-preview">
      {run.error && (
        <p role="alert" className="text-caption text-destructive break-words">
          {run.error}
        </p>
      )}
      {run.plan.changes.length === 0 && run.plan.agent_changes.length === 0 ? (
        <p className="text-caption text-muted-foreground">
          {t(($) => $.lark.organization.no_changes)}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {run.plan.changes.map((change, index) => (
            <li
              key={`${change.user_id}-${change.action}-${change.group_id ?? ""}-${index}`}
              className="space-y-1 px-3 py-2 text-caption"
            >
              <p className="break-words">
                <span className="font-medium">{change.user_name}</span> {change.action}
                {change.group_name ? ` · ${change.group_name}` : ""}
              </p>
              {(change.before !== undefined || change.after !== undefined) && (
                <p className="text-muted-foreground break-words">
                  {formatSyncValue(change.before)} → {formatSyncValue(change.after)}
                </p>
              )}
              {change.reason && (
                <p className="text-muted-foreground break-words">{change.reason}</p>
              )}
            </li>
          ))}
          {run.plan.agent_changes.map((change) => (
            <li
              key={`${change.agent_id}-${change.action}-${change.group_id}`}
              className="px-3 py-2 text-caption break-words"
            >
              <span className="font-medium">
                {agentNames.get(change.agent_id) ??
                  t(($) => $.lark.organization.unknown_agent)}
              </span>{" "}
              {change.action} · {change.group_name}
            </li>
          ))}
        </ul>
      )}
      {run.plan.warnings.length > 0 && (
        <div className="space-y-1 rounded-md bg-muted/60 px-3 py-2">
          <p className="text-caption font-medium">
            {t(($) => $.lark.organization.warnings)}
          </p>
          <ul className="list-disc pl-4 text-caption text-muted-foreground">
            {run.plan.warnings.map((warning) => (
              <li key={warning} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatSyncValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

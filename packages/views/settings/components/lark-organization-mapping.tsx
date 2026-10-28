"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { larkKeys, larkOrganizationOptions } from "@multica/core/lark/queries";
import type {
  LarkInstallation,
  LarkOrganizationCatalog,
  LarkOrganizationMapping as LarkOrganizationMappingValue,
  LarkOrganizationSyncRun,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
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
import { useLocale, useT } from "../../i18n";
import { LarkOrganizationRuleEditor } from "./lark-organization-rule-editor";
import { LarkOrganizationPreview } from "./lark-organization-preview";
import {
  formatOrganizationDate,
  organizationSourceSummary,
  type OrganizationPendingAction,
} from "./lark-organization-display";

export function LarkOrganizationMapping({
  installations,
  canManage,
}: {
  installations: LarkInstallation[];
  canManage: boolean;
}) {
  const { t } = useT("settings");
  const locale = useLocale();
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
  const [pending, setPending] = useState<OrganizationPendingAction>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("rules");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

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

  useEffect(() => {
    if (pending !== "preview") {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  const latestStoredRun = useMemo(
    () =>
      [...(data?.sync_runs ?? [])]
        .filter((candidate) => candidate.mode === "preview" || candidate.mode === "replay")
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null,
    [data?.sync_runs],
  );
  const history = useMemo(
    () => [...(data?.sync_runs ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [data?.sync_runs],
  );
  const displayedRun = run ?? latestStoredRun;
  const config = data?.config ?? null;
  const catalog = data?.catalog ?? null;
  const draftSignature = JSON.stringify({ installation_id: installationId, enabled, mappings });
  const savedSignature = config
    ? JSON.stringify({
        installation_id: config.installation_id,
        enabled: config.enabled,
        mappings: data?.mappings ?? [],
      })
    : null;
  const dirty = !savedSignature || draftSignature !== savedSignature;
  const missingExternalId = mappings.some((mapping) => !mapping.external_id.trim());
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const installationName = (installation: LarkInstallation) =>
    agentNames.get(installation.agent_id) ?? t(($) => $.lark.organization.unknown_agent);
  const selectedInstallation = installations.find((installation) => installation.id === installationId)
    ?? installations.find((installation) => installation.id === config?.installation_id);
  const canApply = Boolean(
    canManage && displayedRun &&
      (displayedRun.mode === "preview" || displayedRun.mode === "replay") &&
      displayedRun.status === "preview" && displayedRun.revision === config?.revision,
  );
  const canReplay = Boolean(
    canManage && displayedRun && (displayedRun.mode === "preview" || displayedRun.mode === "replay"),
  );
  const editingMapping = editingIndex === null ? null : mappings[editingIndex] ?? null;

  async function invalidateOrganization() {
    await queryClient.invalidateQueries({ queryKey: larkKeys.organization(wsId) });
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
      toast.error(error instanceof Error && error.message ? error.message : t(($) => $.lark.organization.save_failed));
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
      setActiveTab("preview");
      await invalidateOrganization();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t(($) => $.lark.organization.preview_failed));
    } finally {
      setPending(null);
    }
  }

  async function replay(source: LarkOrganizationSyncRun) {
    if (pending) return;
    setPending("replay");
    try {
      const nextRun = await api.replayLarkOrganizationSync(wsId, source.id);
      setRun(nextRun);
      setActiveTab("preview");
      await invalidateOrganization();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t(($) => $.lark.organization.replay_failed));
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
      setActiveTab("preview");
      await invalidateOrganization();
      setApplyOpen(false);
      toast.success(t(($) => $.lark.organization.applied));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t(($) => $.lark.organization.apply_failed));
    } finally {
      setPending(null);
    }
  }

  function editMapping(next: LarkOrganizationMappingValue) {
    if (editingIndex === null) {
      setMappings((current) => [...current, next]);
    } else {
      setMappings((current) => current.map((mapping, index) => index === editingIndex ? next : mapping));
    }
  }

  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-body font-semibold">{t(($) => $.lark.organization.title)}</h2>
        <p className="text-caption text-muted-foreground">{t(($) => $.lark.organization.console_description)}</p>
      </div>
      {!canManage && <p className="text-caption text-muted-foreground">{t(($) => $.lark.organization.read_only)}</p>}
      {isLoading ? (
        <Card><CardContent><p className="text-body text-muted-foreground">{t(($) => $.lark.organization.loading)}</p></CardContent></Card>
      ) : isError ? (
        <Card><CardContent><p role="alert" className="text-body text-destructive">{t(($) => $.lark.organization.load_error)}</p></CardContent></Card>
      ) : (
        <>
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {selectedInstallation?.status === "active" ? (
                    <>
                      <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
                      <Badge variant="secondary">{t(($) => $.lark.organization.connection_connected)}</Badge>
                    </>
                  ) : selectedInstallation ? (
                    <Badge variant="outline">{t(($) => $.lark.revoked_badge)}</Badge>
                  ) : null}
                  <span className="text-body font-medium">
                    {selectedInstallation ? installationName(selectedInstallation) : t(($) => $.lark.organization.no_active_installations)}
                  </span>
                </div>
                {canManage && (
                  <Button variant="outline" disabled={dirty || !config || pending !== null} aria-busy={pending === "preview" || undefined} onClick={preview}>
                    {pending === "preview" ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                    {pending === "preview" ? t(($) => $.lark.organization.previewing) : t(($) => $.lark.organization.sync_now)}
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label={t(($) => $.lark.organization.stats_departments)} value={catalog?.departments.length ?? "—"} />
                <Metric label={t(($) => $.lark.organization.stats_members)} value={catalog?.total_users ?? "—"} />
                <Metric label={t(($) => $.lark.organization.stats_job_title_users)} value={catalog?.job_title_users ?? "—"} />
                <Metric label={t(($) => $.lark.organization.last_sync)} value={catalog ? formatOrganizationDate(catalog.snapshot_at, locale) : t(($) => $.lark.organization.not_synced)} />
              </div>
              {pending === "preview" && (
                <p role="status" className="text-caption text-muted-foreground">
                  {t(($) => $.lark.organization.sync_waiting, { seconds: elapsed })}
                </p>
              )}
              {canManage && dirty && <p className="text-caption text-muted-foreground">{t(($) => $.lark.organization.preview_save_first)}</p>}
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(String(value))}>
            <TabsList aria-label={t(($) => $.lark.organization.title)} className="grid w-full grid-cols-2 sm:inline-flex sm:w-fit">
              <TabsTrigger value="rules">{t(($) => $.lark.organization.tabs_rules)}</TabsTrigger>
              <TabsTrigger value="preview">{t(($) => $.lark.organization.tabs_preview)}</TabsTrigger>
              <TabsTrigger value="members">{t(($) => $.lark.organization.tabs_members)}</TabsTrigger>
              <TabsTrigger value="history">{t(($) => $.lark.organization.tabs_history)}</TabsTrigger>
            </TabsList>
            <TabsContent value="rules" className="space-y-4 data-hidden:hidden">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  {canManage ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-source`} className="sr-only">{t(($) => $.lark.organization.source)}</Label>
                      {activeInstallations.length > 0 ? (
                        <Select
                          items={activeInstallations.map((installation) => ({ value: installation.id, label: installationName(installation) }))}
                          value={installationId}
                          onValueChange={(value) => setInstallationId(value ?? "")}
                        >
                          <SelectTrigger id={`${id}-source`} className="w-56"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {activeInstallations.map((installation) => (
                              <SelectItem key={installation.id} value={installation.id}>{installationName(installation)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : <span className="text-caption text-muted-foreground">{t(($) => $.lark.organization.no_active_installations)}</span>}
                    </div>
                  ) : (
                    <span className="text-caption text-muted-foreground">
                      {t(($) => $.lark.organization.enabled)}: {config?.enabled ? t(($) => $.lark.organization.enabled_yes) : t(($) => $.lark.organization.enabled_no)}
                    </span>
                  )}
                  {canManage && (
                    <div className="flex items-center gap-2 pb-2">
                      <Label htmlFor={`${id}-enabled`}>{t(($) => $.lark.organization.enabled)}</Label>
                      <Switch id={`${id}-enabled`} checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} disabled={pending !== null} />
                    </div>
                  )}
                </div>
                {canManage && (
                  <Button variant="outline" disabled={!catalog || pending !== null} onClick={() => { setEditingIndex(null); setEditorOpen(true); }}>
                    <Plus />{t(($) => $.lark.organization.rule_add)}
                  </Button>
                )}
              </div>

              {canManage && dirty && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <p className="text-caption">{t(($) => $.lark.organization.unsaved_changes)}</p>
                  <Button size="sm" disabled={!installationId || missingExternalId || pending !== null} aria-busy={pending === "save" || undefined} onClick={save}>
                    {pending === "save" && <LoaderCircle className="animate-spin" />}
                    {pending === "save" ? t(($) => $.lark.organization.saving) : t(($) => $.lark.organization.save)}
                  </Button>
                </div>
              )}

              {mappings.length === 0 ? (
                <Card><CardContent className="space-y-2 py-6 text-center">
                  <p className="text-body font-medium">{t(($) => $.lark.organization.no_rules_title)}</p>
                  <p className="text-caption text-muted-foreground">{t(($) => $.lark.organization.no_rules_description)}</p>
                </CardContent></Card>
              ) : (
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>{t(($) => $.lark.organization.rule_source)}</TableHead>
                    <TableHead>{t(($) => $.lark.organization.member_role)}</TableHead>
                    <TableHead>{t(($) => $.lark.organization.agents)}</TableHead>
                    {canManage && <TableHead className="w-24"><span className="sr-only">{t(($) => $.lark.organization.rule_actions)}</span></TableHead>}
                  </TableRow></TableHeader>
                  <TableBody>
                    {mappings.map((mapping, index) => {
                      const source = organizationSourceSummary(mapping, catalog);
                      return (
                        <TableRow key={`${mapping.kind}-${mapping.external_id}-${index}`}>
                          <TableCell className="whitespace-normal">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline">{mapping.kind === "department" ? t(($) => $.lark.organization.department) : mapping.kind === "job_title" ? t(($) => $.lark.organization.job_title) : mapping.kind}</Badge>
                                <span className="font-medium">{source.name}</span>
                              </div>
                              <div className="text-caption text-muted-foreground">
                                {source.count !== null ? t(($) => $.lark.organization.source_member, { count: source.count }) : ""}
                                {source.missing && <span className="text-amber-600">{t(($) => $.lark.organization.source_missing)}</span>}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>{mapping.member_role ?? t(($) => $.lark.organization.no_member_role)}</TableCell>
                          <TableCell className="whitespace-normal">
                            {mapping.agent_ids.length
                              ? mapping.agent_ids.map((agentId) => agentNames.get(agentId) ?? t(($) => $.lark.organization.unknown_agent)).join(", ")
                              : t(($) => $.lark.organization.no_agent_grant)}
                          </TableCell>
                          {canManage && (
                            <TableCell>
                              <div className="flex justify-end">
                                <Button variant="ghost" size="icon-sm" aria-label={t(($) => $.lark.organization.rule_edit, { name: source.name })} onClick={() => { setEditingIndex(index); setEditorOpen(true); }}>
                                  <Pencil />
                                </Button>
                                <Button variant="ghost" size="icon-sm" aria-label={t(($) => $.lark.organization.remove_mapping_named, { name: source.name })} onClick={() => setMappings((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                                  <Trash2 />
                                </Button>
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              <details className="rounded-md border px-3 py-2">
                <summary className="cursor-pointer text-caption font-medium">{t(($) => $.lark.organization.advanced_diagnostics)}</summary>
                <div className="grid gap-4 pt-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <h3 className="text-caption font-medium">{t(($) => $.lark.organization.required_scopes)}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {(data?.required_scopes ?? []).map((scope) => <code key={scope} className="rounded-xs bg-muted px-1.5 py-0.5 text-micro break-all">{scope}</code>)}
                    </div>
                    <h3 className="pt-2 text-caption font-medium">{t(($) => $.lark.organization.requirements)}</h3>
                    <ul className="list-disc space-y-1 pl-4 text-caption text-muted-foreground">
                      {(data?.requirements ?? []).map((requirement) => <li key={requirement}><OrganizationRequirement value={requirement} /></li>)}
                    </ul>
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-caption font-medium">{t(($) => $.lark.organization.external_identifiers)}</h3>
                    {mappings.map((mapping, index) => (
                      <div key={`${mapping.external_id}-${index}`} className="text-caption text-muted-foreground">
                        <span>{mapping.external_name || mapping.external_id}</span>
                        <code className="ml-2 break-all">{mapping.external_id}</code>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            </TabsContent>

            <TabsContent value="preview" className="data-hidden:hidden">
              {displayedRun ? (
                <LarkOrganizationPreview
                  run={displayedRun}
                  agentNames={agentNames}
                  canApply={canApply}
                  canReplay={canReplay}
                  stale={displayedRun.revision !== config?.revision && displayedRun.status === "preview"}
                  pending={pending}
                  onReplay={() => displayedRun && replay(displayedRun)}
                  onApply={() => setApplyOpen(true)}
                />
              ) : (
                <Card><CardContent className="space-y-3 py-6 text-center">
                  <p className="text-body text-muted-foreground">{t(($) => $.lark.organization.no_preview)}</p>
                  <p className="text-caption text-muted-foreground">{t(($) => $.lark.organization.preview_description)}</p>
                </CardContent></Card>
              )}
            </TabsContent>

            <TabsContent value="members" className="data-hidden:hidden">
              <WorkspaceMembers catalog={catalog} />
            </TabsContent>

            <TabsContent value="history" className="data-hidden:hidden">
              <SyncHistory runs={history} canManage={canManage} pending={pending} onReplay={replay} />
            </TabsContent>
          </Tabs>
        </>
      )}

      {canManage && (
        <LarkOrganizationRuleEditor
          open={editorOpen}
          mapping={editingMapping}
          catalog={catalog}
          agents={agents}
          onOpenChange={setEditorOpen}
          onSave={editMapping}
        />
      )}

      {canManage && (
        <AlertDialog open={applyOpen} onOpenChange={(open) => { if (!open && pending !== "apply") setApplyOpen(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(($) => $.lark.organization.apply_confirm_title)}</AlertDialogTitle>
              <AlertDialogDescription>{t(($) => $.lark.organization.apply_confirm_description)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending === "apply"}>{t(($) => $.lark.organization.apply_confirm_cancel)}</AlertDialogCancel>
              <AlertDialogAction
                disabled={!canApply || pending === "apply"}
                aria-busy={pending === "apply" || undefined}
                onClick={(event) => { event.preventDefault(); void apply(); }}
              >
                {pending === "apply" && <LoaderCircle className="animate-spin" />}
                {pending === "apply" ? t(($) => $.lark.organization.applying) : t(($) => $.lark.organization.apply)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="space-y-1">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="text-body font-medium break-words">{value}</p>
    </div>
  );
}

function WorkspaceMembers({ catalog }: { catalog: LarkOrganizationCatalog | null }) {
  const { t } = useT("settings");
  const [search, setSearch] = useState("");
  const members = catalog?.workspace_members ?? [];
  const filtered = members.filter((member) =>
    `${member.name} ${member.job_title} ${member.departments.join(" ")} ${member.role}`
      .toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-caption text-muted-foreground">{t(($) => $.lark.organization.members_note)}</p>
        <div className="relative w-full sm:w-64">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t(($) => $.lark.organization.members_search_placeholder)} aria-label={t(($) => $.lark.organization.members_search_placeholder)} />
        </div>
      </div>
      {filtered.length === 0 ? (
        <Card><CardContent><p className="py-4 text-center text-body text-muted-foreground">{members.length === 0 ? (catalog ? t(($) => $.lark.organization.members_empty) : t(($) => $.lark.organization.not_synced)) : t(($) => $.lark.organization.members_no_results)}</p></CardContent></Card>
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t(($) => $.lark.organization.member_name)}</TableHead>
            <TableHead>{t(($) => $.lark.organization.member_role)}</TableHead>
            <TableHead>{t(($) => $.lark.organization.job_title)}</TableHead>
            <TableHead>{t(($) => $.lark.organization.department)}</TableHead>
            <TableHead>{t(($) => $.lark.organization.member_link_status)}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {filtered.map((member) => (
              <TableRow key={member.user_id}>
                <TableCell>
                  <div className="font-medium">{member.name}</div>
                  {member.disabled && <div className="text-caption text-muted-foreground">{t(($) => $.lark.organization.members_disabled)}</div>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span>{member.role}</span>
                    {member.managed_role && <Badge variant="outline">{t(($) => $.lark.organization.members_managed)}</Badge>}
                  </div>
                </TableCell>
                <TableCell>{member.job_title || "—"}</TableCell>
                <TableCell className="whitespace-normal">{member.departments.join("、") || "—"}</TableCell>
                <TableCell>
                  <Badge variant={member.identity_conflict ? "destructive" : member.linked ? "secondary" : "outline"}>
                    {member.identity_conflict ? t(($) => $.lark.organization.members_conflict) : member.linked ? t(($) => $.lark.organization.members_linked) : t(($) => $.lark.organization.members_unlinked)}
                  </Badge>
                  {member.linked && member.feishu_active === false && <div className="mt-1 text-caption text-muted-foreground">{t(($) => $.lark.organization.members_feishu_inactive)}</div>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function SyncHistory({
  runs,
  canManage,
  pending,
  onReplay,
}: {
  runs: LarkOrganizationSyncRun[];
  canManage: boolean;
  pending: OrganizationPendingAction;
  onReplay: (run: LarkOrganizationSyncRun) => void;
}) {
  const { t } = useT("settings");
  const locale = useLocale();
  if (runs.length === 0) {
    return <Card><CardContent><p className="py-4 text-center text-body text-muted-foreground">{t(($) => $.lark.organization.history_empty)}</p></CardContent></Card>;
  }
  return (
    <Table>
      <TableHeader><TableRow>
        <TableHead>{t(($) => $.lark.organization.history_time)}</TableHead>
        <TableHead>{t(($) => $.lark.organization.history_mode)}</TableHead>
        <TableHead>{t(($) => $.lark.organization.history_status)}</TableHead>
        <TableHead>{t(($) => $.lark.organization.preview_member_changes)}</TableHead>
        <TableHead>{t(($) => $.lark.organization.preview_agent_changes)}</TableHead>
        {canManage && <TableHead><span className="sr-only">{t(($) => $.lark.organization.rule_actions)}</span></TableHead>}
      </TableRow></TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>{formatOrganizationDate(run.created_at, locale)}</TableCell>
            <TableCell><HistoryMode run={run} /></TableCell>
            <TableCell><HistoryStatus run={run} /></TableCell>
            <TableCell>{run.plan.changes.length}</TableCell>
            <TableCell>{run.plan.agent_changes.length}</TableCell>
            {canManage && (
              <TableCell>
                {(run.mode === "preview" || run.mode === "replay") && (
                  <Button variant="ghost" size="sm" disabled={pending !== null} onClick={() => onReplay(run)}>
                    {pending === "replay" ? t(($) => $.lark.organization.replaying) : t(($) => $.lark.organization.replay)}
                  </Button>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function HistoryMode({ run }: { run: LarkOrganizationSyncRun }) {
  const { t } = useT("settings");
  switch (run.mode) {
    case "preview": return <>{t(($) => $.lark.organization.history_mode_preview)}</>;
    case "replay": return <>{t(($) => $.lark.organization.history_mode_replay)}</>;
    case "apply": return <>{t(($) => $.lark.organization.history_mode_apply)}</>;
    default: return <>{run.mode}</>;
  }
}

function HistoryStatus({ run }: { run: LarkOrganizationSyncRun }) {
  const { t } = useT("settings");
  switch (run.status) {
    case "preview": return <Badge variant="outline">{t(($) => $.lark.organization.status_preview)}</Badge>;
    case "completed": return <Badge variant="secondary">{t(($) => $.lark.organization.status_completed)}</Badge>;
    case "failed": return <Badge variant="destructive">{t(($) => $.lark.organization.status_failed)}</Badge>;
    default: return <Badge variant="outline">{run.status}</Badge>;
  }
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

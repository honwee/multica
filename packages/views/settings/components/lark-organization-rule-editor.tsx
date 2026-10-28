"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type {
  Agent,
  LarkOrganizationCatalog,
  LarkOrganizationMemberRole,
  LarkOrganizationMapping,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { useT } from "../../i18n";

interface SourceOption {
  id: string;
  name: string;
  count: number | null;
  duplicate: boolean;
  missing?: boolean;
  workspaceMember?: boolean;
  active?: boolean;
  jobTitle?: string;
  departments?: string[];
}

export function LarkOrganizationRuleEditor({
  open,
  mapping,
  catalog,
  agents,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  mapping: LarkOrganizationMapping | null;
  catalog: LarkOrganizationCatalog | null | undefined;
  agents: Agent[];
  onOpenChange: (open: boolean) => void;
  onSave: (mapping: LarkOrganizationMapping) => void;
}) {
  const { t } = useT("settings");
  const id = useId();
  const [kind, setKind] = useState("department");
  const [externalId, setExternalId] = useState("");
  const [externalName, setExternalName] = useState("");
  const [memberRole, setMemberRole] = useState<LarkOrganizationMemberRole | null>("member");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(mapping?.kind ?? "department");
    setExternalId(mapping?.external_id ?? "");
    setExternalName(mapping?.external_name ?? "");
    setMemberRole(mapping ? mapping.member_role : "member");
    setAgentIds(mapping?.agent_ids ?? []);
    setSearch("");
    setShowError(false);
  }, [open, mapping]);

  const sources = useMemo<SourceOption[]>(() => {
    const items: SourceOption[] = kind === "department"
      ? (catalog?.departments ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          count: item.direct_member_count,
          duplicate: (catalog?.departments.filter((other) => other.name === item.name).length ?? 0) > 1,
        }))
      : kind === "job_title"
        ? (catalog?.job_titles ?? []).map((item) => ({
            id: item.name,
            name: item.name,
            count: item.member_count,
            duplicate: false,
          }))
        : kind === "user"
          ? (catalog?.users ?? []).map((item) => ({
              id: item.union_id,
              name: item.name,
              count: null,
              duplicate: (catalog?.users.filter((other) => other.name === item.name).length ?? 0) > 1,
              workspaceMember: item.workspace_member,
              active: item.active,
              jobTitle: item.job_title,
              departments: item.departments,
            }))
          : [];
    if (mapping && mapping.kind === kind && !items.some((item) => item.id === mapping.external_id)) {
      items.push({
        id: mapping.external_id,
        name: mapping.external_name || mapping.external_id,
        count: null,
        duplicate: false,
        missing: true,
      });
    }
    return items;
  }, [kind, catalog, mapping]);

  const filteredSources = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return sources.slice(0, 40);
    return sources.filter((item) =>
      `${item.name} ${item.id}`.toLocaleLowerCase().includes(query),
    ).slice(0, 40);
  }, [sources, search]);
  const selected = sources.find((item) => item.id === externalId);

  function selectSource(source: SourceOption) {
    setExternalId(source.id);
    setExternalName(source.name);
    setShowError(false);
  }

  function save() {
    if (!externalId) {
      setShowError(true);
      return;
    }
    onSave({
      kind,
      external_id: externalId,
      external_name: externalName || selected?.name || externalId,
      member_role: memberRole,
      agent_ids: agentIds,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mapping ? t(($) => $.lark.organization.rule_edit_title) : t(($) => $.lark.organization.rule_add_title)}
          </DialogTitle>
          <DialogDescription>{t(($) => $.lark.organization.rule_dialog_description)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-kind`}>{t(($) => $.lark.organization.mapping_kind)}</Label>
            <Select
              items={[
                { value: "department", label: t(($) => $.lark.organization.department) },
                { value: "job_title", label: t(($) => $.lark.organization.job_title) },
                { value: "user", label: t(($) => $.lark.organization.user) },
              ]}
              value={kind}
              onValueChange={(value) => {
                if (!value) return;
                setKind(value);
                setExternalId("");
                setExternalName("");
                setSearch("");
              }}
            >
              <SelectTrigger id={`${id}-kind`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="department">{t(($) => $.lark.organization.department)}</SelectItem>
                <SelectItem value="job_title">{t(($) => $.lark.organization.job_title)}</SelectItem>
                <SelectItem value="user">{t(($) => $.lark.organization.user)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-role`}>{t(($) => $.lark.organization.member_role)}</Label>
            <Select
              items={[
                { value: "member", label: "member" },
                { value: "admin", label: "admin" },
                { value: "owner", label: "owner" },
                { value: "none", label: t(($) => $.lark.organization.no_member_role) },
              ]}
              value={memberRole ?? "none"}
              onValueChange={(value) => setMemberRole(value === "none" ? null : (value as LarkOrganizationMemberRole))}
            >
              <SelectTrigger id={`${id}-role`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t(($) => $.lark.organization.role_member)}</SelectItem>
                <SelectItem value="admin">{t(($) => $.lark.organization.role_admin)}</SelectItem>
                <SelectItem value="owner">{t(($) => $.lark.organization.role_owner)}</SelectItem>
                <SelectItem value="none">{t(($) => $.lark.organization.no_member_role)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-search`}>{t(($) => $.lark.organization.rule_source)}</Label>
          <div className="relative">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={`${id}-search`}
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t(($) => $.lark.organization.catalog_search_placeholder)}
            />
          </div>
          <div className="max-h-56 overflow-y-auto rounded-md border" role="listbox" aria-label={t(($) => $.lark.organization.rule_source)}>
            {filteredSources.length === 0 ? (
              <p className="p-4 text-caption text-muted-foreground">{t(($) => $.lark.organization.catalog_empty)}</p>
            ) : filteredSources.map((source) => (
              <button
                type="button"
                role="option"
                aria-selected={externalId === source.id}
                key={source.id}
                className="flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left last:border-0 hover:bg-muted/60 aria-selected:bg-muted"
                onClick={() => selectSource(source)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-body">{source.name}</span>
                  {source.jobTitle && <span className="block text-caption text-muted-foreground">{source.jobTitle}</span>}
                  {!!source.departments?.length && <span className="block text-micro text-muted-foreground">{source.departments.join("、")}</span>}
                  {kind === "user" && (
                    <span className={source.workspaceMember ? "block text-caption text-muted-foreground" : "block text-caption text-amber-600"}>
                      {source.workspaceMember ? t(($) => $.lark.organization.workspace_member_yes) : t(($) => $.lark.organization.workspace_member_no)}
                    </span>
                  )}
                  {source.active === false && <span className="block text-caption text-amber-600">{t(($) => $.lark.organization.members_feishu_inactive)}</span>}
                  {source.duplicate && <span className="block text-micro text-muted-foreground">{`ID ···${source.id.slice(-6)}`}</span>}
                  {source.missing && <span className="block text-micro text-amber-600">{t(($) => $.lark.organization.source_missing)}</span>}
                </span>
                {source.count !== null && (
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {t(($) => $.lark.organization.source_member, { count: source.count })}
                  </span>
                )}
              </button>
            ))}
          </div>
          {showError && <p className="text-caption text-destructive">{t(($) => $.lark.organization.source_required)}</p>}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-caption font-medium">{t(($) => $.lark.organization.agents)}</legend>
          <p className="text-caption text-muted-foreground">{t(($) => $.lark.organization.agent_scope_note)}</p>
          <div className="grid max-h-32 gap-2 overflow-y-auto sm:grid-cols-2">
            {agents.map((agent) => {
              const checked = agentIds.includes(agent.id);
              return (
                <div key={agent.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-agent-${agent.id}`}
                    checked={checked}
                    onCheckedChange={(next) => setAgentIds((current) =>
                      next === true ? [...current, agent.id] : current.filter((item) => item !== agent.id),
                    )}
                  />
                  <Label htmlFor={`${id}-agent-${agent.id}`} className="truncate font-normal">{agent.name}</Label>
                </div>
              );
            })}
          </div>
        </fieldset>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t(($) => $.lark.organization.apply_confirm_cancel)}
          </DialogClose>
          <Button onClick={save}>{t(($) => $.lark.organization.rule_save)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

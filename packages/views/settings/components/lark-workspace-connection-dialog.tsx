"use client";

import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { larkKeys } from "@multica/core/lark";
import { Button } from "@multica/ui/components/ui/button";
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

export function LarkWorkspaceConnectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const id = useId();
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [tenantKey, setTenantKey] = useState("");
  const [region, setRegion] = useState<"feishu" | "lark">("feishu");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setAppId("");
    setAppSecret("");
    setTenantKey("");
    setRegion("feishu");
    setPending(false);
    setError("");
  }, [open]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !appId.trim() || !appSecret.trim()) return;
    setPending(true);
    setError("");
    try {
      await api.connectLarkWorkspace(wsId, {
        app_id: appId.trim(),
        app_secret: appSecret,
        tenant_key: tenantKey.trim(),
        region,
      });
      await queryClient.invalidateQueries({ queryKey: larkKeys.installations(wsId) });
      toast.success(t(($) => $.lark.workspace_connect_success));
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t(($) => $.lark.workspace_connect_failed));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.lark.workspace_connect_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.lark.workspace_connect_description)}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-app-id`}>{t(($) => $.lark.workspace_app_id_label)}</Label>
            <Input
              id={`${id}-app-id`}
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-app-secret`}>{t(($) => $.lark.workspace_app_secret_label)}</Label>
            <Input
              id={`${id}-app-secret`}
              type="password"
              value={appSecret}
              onChange={(event) => setAppSecret(event.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-tenant-key`}>{t(($) => $.lark.workspace_tenant_key_label)}</Label>
              <Input id={`${id}-tenant-key`} value={tenantKey} onChange={(event) => setTenantKey(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-region`}>{t(($) => $.lark.workspace_region_label)}</Label>
              <Select
                items={[
                  { value: "feishu", label: t(($) => $.lark.region_feishu) },
                  { value: "lark", label: t(($) => $.lark.region_lark) },
                ]}
                value={region}
                onValueChange={(value) => setRegion(value === "lark" ? "lark" : "feishu")}
              >
                <SelectTrigger id={`${id}-region`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="feishu">{t(($) => $.lark.region_feishu)}</SelectItem>
                  <SelectItem value="lark">{t(($) => $.lark.region_lark)}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={pending} />}>
              {t(($) => $.lark.install_close)}
            </DialogClose>
            <Button type="submit" disabled={pending || !appId.trim() || !appSecret.trim()} aria-busy={pending || undefined}>
              {pending && <LoaderCircle className="animate-spin" />}
              {pending ? t(($) => $.lark.workspace_connect_submitting) : t(($) => $.lark.workspace_connect_submit)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

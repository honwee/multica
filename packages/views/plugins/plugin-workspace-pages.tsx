"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { pluginExtensionsFromSettings, pluginInstallationsOptions } from "@multica/core/plugins";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { useFeatureEnabled } from "@multica/core/config";
import { PLUGINS_V1_FLAG } from "@multica/core/feature-flags";
import type { PluginInstallation, PluginSurface } from "@multica/core/types";
import { Blocks } from "@multica/ui/icons";
import { useT } from "../i18n";
import { isDesktopShell } from "../platform/local-directory";
import { PageHeader } from "../layout/page-header";
import { PanelLink, PanelList, PanelSection, isPathWithin } from "../layout/panel-nav";
import { PluginSurfaceFrame } from "./plugin-surface-frame";

/**
 * Fork extension point (FORK.md): plugin `workspace_page` surfaces.
 *
 * A page is listed only when the Plugins flag is on, the workspace switched
 * pages on in `settings.plugin_extensions`, and an enabled installation
 * declares one for this platform. Otherwise nothing renders and the sidebar
 * is unchanged. The server refuses to launch a page while the switch is off,
 * so a stale link cannot bypass this filter.
 */
export interface PluginWorkspacePageEntry {
  installation: PluginInstallation;
  surface: PluginSurface;
}

export function collectWorkspacePages(
  installations: PluginInstallation[],
  platform: "web" | "desktop",
): PluginWorkspacePageEntry[] {
  return installations
    .filter((installation) => installation.enabled === true)
    .flatMap((installation) =>
      installation.surfaces
        .filter((surface) => surface.type === "workspace_page")
        .filter((surface) => (surface.platforms ?? []).length === 0 || (surface.platforms ?? []).includes(platform))
        .map((surface) => ({ installation, surface })),
    );
}

export function useWorkspacePluginPages(): { wsId: string; pages: PluginWorkspacePageEntry[]; ready: boolean } {
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id ?? "";
  const pluginsEnabled = useFeatureEnabled(PLUGINS_V1_FLAG, false);
  const pagesOn = pluginExtensionsFromSettings(workspace?.settings).workspace_pages;
  const enabled = pluginsEnabled && pagesOn && wsId.length > 0;
  const { data, isPending } = useQuery({ ...pluginInstallationsOptions(wsId), enabled });
  const platform = isDesktopShell() ? "desktop" : "web";
  const pages = useMemo(
    () => (enabled ? collectWorkspacePages(data?.plugins ?? [], platform) : []),
    [enabled, data, platform],
  );
  return { wsId, pages, ready: !enabled || !isPending };
}

/** The Work panel's list of plugin pages. Renders nothing when there are none. */
export function PluginPagesSection({ pathname }: { pathname: string }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const { pages } = useWorkspacePluginPages();
  if (pages.length === 0) return null;
  return (
    <PanelSection label={t(($) => $.panels.work.plugin_pages)}>
      <PanelList>
        {pages.map(({ installation, surface }) => {
          const href = p.pluginPage(installation.id, surface.key);
          return (
            <PanelLink
              key={`${installation.id}:${surface.key}`}
              href={href}
              label={surface.name}
              active={isPathWithin(pathname, href)}
              icon={<Blocks />}
            />
          );
        })}
      </PanelList>
    </PanelSection>
  );
}

const PAGE_FRAME_HEIGHT = 640;

/** The route body for `/{slug}/plugins/{installationId}/{surfaceKey}`. */
export function PluginWorkspacePage({ installationId, surfaceKey }: { installationId: string; surfaceKey: string }) {
  const { t } = useT("layout");
  const { wsId, pages, ready } = useWorkspacePluginPages();
  const entry = pages.find(
    ({ installation, surface }) => installation.id === installationId && surface.key === surfaceKey,
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        <h1 className="min-w-0 truncate text-body font-medium">{entry?.surface.name ?? ""}</h1>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {entry ? (
          <PluginSurfaceFrame
            key={`${entry.installation.id}:${entry.surface.key}`}
            wsId={wsId}
            installation={entry.installation}
            surface={entry.surface}
            defaultHeight={PAGE_FRAME_HEIGHT}
          />
        ) : ready ? (
          <p className="text-caption text-muted-foreground">{t(($) => $.panels.work.plugin_page_unavailable)}</p>
        ) : null}
      </div>
    </div>
  );
}

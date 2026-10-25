export interface MoreNavItem {
  labelKey:
    | "more_menu.pinned"
    | "more_menu.issues"
    | "more_menu.projects"
    | "routes.agents";
  icon: string;
  path: string;
}

export const MORE_NAV_ITEMS = [
  { labelKey: "more_menu.pinned", icon: "pin", path: "/more/pins" },
  { labelKey: "more_menu.issues", icon: "list.bullet", path: "/more/issues" },
  {
    labelKey: "more_menu.projects",
    icon: "square.stack",
    path: "/more/projects",
  },
  { labelKey: "routes.agents", icon: "sparkles", path: "/more/agents" },
] as const satisfies readonly MoreNavItem[];

export function moreNavItemHref(slug: string, path: string): string {
  return `/${slug}${path}`;
}

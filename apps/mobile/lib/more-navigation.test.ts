// @vitest-environment node
import { describe, expect, it } from "vitest";
import enNavigation from "../locales/en/navigation.json";
import zhNavigation from "../locales/zh-Hans/navigation.json";
import { MORE_NAV_ITEMS, moreNavItemHref } from "./more-navigation";

describe("More navigation", () => {
  it("links to Agents with its SF Symbol and existing localized labels", () => {
    const item = MORE_NAV_ITEMS.find(({ path }) => path === "/more/agents");

    expect(item).toBeDefined();
    if (!item) throw new Error("Missing Agents item in More navigation");
    expect(item.labelKey).toBe("routes.agents");
    expect(item.icon).toBe("sparkles");
    expect(moreNavItemHref("acme", item.path)).toBe("/acme/more/agents");
    expect(enNavigation.routes.agents).toBe("Agents");
    expect(zhNavigation.routes.agents).toBe("智能体");
  });
});

// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SURFACE_THEME_TOKENS, buildSurfaceFrameDocument, readThemeTokens } from "./surface-document";

describe("plugin surface theme tokens", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the eleven tokens older clients forwarded at the head of the list", () => {
    expect(SURFACE_THEME_TOKENS.slice(0, 11)).toEqual([
      "--background",
      "--foreground",
      "--muted",
      "--muted-foreground",
      "--border",
      "--primary",
      "--primary-foreground",
      "--destructive",
      "--radius",
      "--text-caption",
      "--text-body",
    ]);
  });

  it("forwards the surface, geometry and type tokens a list page needs", () => {
    expect(SURFACE_THEME_TOKENS).toEqual(expect.arrayContaining([
      "--card",
      "--accent",
      "--input",
      "--ring",
      "--success",
      "--surface-hover",
      "--surface-selected",
      "--surface-selected-foreground",
      "--radius-md",
      "--issue-row-height",
      "--button-height-sm",
      "--font-mono",
      "--text-label",
      "--text-label--line-height",
      "--text-title--line-height",
    ]));
    expect(new Set(SURFACE_THEME_TOKENS).size).toBe(SURFACE_THEME_TOKENS.length);
  });

  it("only forwards tokens the shared stylesheet defines", () => {
    const css = readFileSync(new URL("../../ui/styles/tokens.css", import.meta.url), "utf8");
    const missing = SURFACE_THEME_TOKENS.filter((name) => !css.includes(`${name}:`));
    expect(missing).toEqual([]);
  });

  it("reads trimmed computed values and skips tokens the page does not define", () => {
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: (name: string) =>
        ({ "--surface-hover": " oklch(0.967 0.001 286.375) ", "--issue-row-height": "36px" })[name] ?? "",
    }));

    expect(readThemeTokens({} as Element)).toEqual({
      "--surface-hover": "oklch(0.967 0.001 286.375)",
      "--issue-row-height": "36px",
    });
    expect(readThemeTokens(null)).toEqual({});
  });
});

describe("plugin surface frame document", () => {
  it("allows the nested frame to navigate only to the hosted content origin", () => {
    const document = buildSurfaceFrameDocument({
      url: "https://plugin-content.example.test/plugin-surfaces/opaque-token",
      bridgeToken: "one-use-proof",
    });

    expect(document).toContain("frame-src https://plugin-content.example.test");
    expect(document).not.toContain("frame-src https:;");
    expect(document).toContain("connect-src 'none'");
  });

  it("keeps the untrusted inner frame opaque", () => {
    const document = buildSurfaceFrameDocument({
      url: "https://plugin-content.example.test/plugin-surfaces/opaque-token",
      bridgeToken: "one-use-proof",
    });

    expect(document).toContain('child.setAttribute("sandbox", "allow-scripts")');
    expect(document).not.toContain('child.setAttribute("sandbox", "allow-scripts allow-same-origin")');
  });

  it("checks source, protocol, challenge and one-time use before relaying a guest port", () => {
    const document = buildSurfaceFrameDocument({
      url: "https://plugin-content.example.test/plugin-surfaces/opaque-token",
      bridgeToken: "one-use-proof",
    });

    expect(document).toContain("event.source !== child.contentWindow");
    expect(document).toContain("data.version !== 2");
    expect(document).toContain("data.challenge !== config.bridgeToken");
    expect(document).toContain('state !== "launching"');
    expect(document).toContain('state = "connected"');
  });

  it("uses terminal state instead of guessing when CSP reports navigation", () => {
    const document = buildSurfaceFrameDocument({
      url: "https://plugin-content.example.test/plugin-surfaces/opaque-token",
      bridgeToken: "one-use-proof",
    });

    expect(document).toContain("securitypolicyviolation");
    expect(document).toContain("multica:plugin-surface-navigation-blocked");
    expect(document).toContain('if (state === "terminal") return');
    expect(document).not.toContain("setTimeout(");
  });

  it("never interpolates the launch URL or proof into executable source", () => {
    const document = buildSurfaceFrameDocument({
      url: "https://plugin-content.example.test/plugin-surfaces/%3C/script%3E",
      bridgeToken: `proof</script><script>alert(1)</script>`,
    });

    expect(document).not.toContain("alert(1)");
    expect(document).not.toContain("proof</script>");
  });

  it("rejects a non-HTTP launch", () => {
    expect(() => buildSurfaceFrameDocument({ url: "javascript:alert(1)", bridgeToken: "proof" })).toThrow();
  });
});

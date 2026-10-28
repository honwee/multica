// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("fumadocs-mdx/next", () => ({
  createMDX: () => (config: unknown) => config,
}));

import nextConfig from "./next.config";

describe("Next proxy limits", () => {
  it("allows longer organization previews without unbounded waits", () => {
    expect(nextConfig.experimental?.proxyTimeout).toBe(120_000);
  });
});

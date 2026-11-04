import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeModelListRequest } from "@multica/core/types";
import { resolveRuntimeModels, runtimeModelsOptions } from "./runtimes";

const mocks = vi.hoisted(() => ({
  initiateListModels: vi.fn(),
  getListModelsResult: vi.fn(),
}));

vi.mock("@/data/api", () => ({ api: mocks }));

function response(
  overrides: Partial<RuntimeModelListRequest> = {},
): RuntimeModelListRequest {
  return {
    id: "request-1",
    runtime_id: "runtime-1",
    status: "completed",
    supported: true,
    created_at: "2026-10-27T11:00:00Z",
    updated_at: "2026-10-27T11:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.initiateListModels.mockReset();
  mocks.getListModelsResult.mockReset();
});

describe("runtime model discovery", () => {
  it("resolves a completed catalog, including an explicitly empty directory", async () => {
    mocks.initiateListModels.mockResolvedValue(response({ models: [] }));
    await expect(resolveRuntimeModels("runtime-1")).resolves.toMatchObject({
      models: [],
      supported: true,
    });
    expect(mocks.getListModelsResult).not.toHaveBeenCalled();
  });

  it("polls until the runtime reports its catalog", async () => {
    vi.useFakeTimers();
    try {
      mocks.initiateListModels.mockResolvedValue(response({ status: "pending" }));
      mocks.getListModelsResult.mockResolvedValue(
        response({ models: [{ id: "kimi", label: "Kimi" }] }),
      );
      const pending = resolveRuntimeModels("runtime-1");
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toMatchObject({
        models: [{ id: "kimi", label: "Kimi" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces discovery failure instead of fabricating an empty catalog", async () => {
    mocks.initiateListModels.mockResolvedValue(
      response({ status: "failed", error: "runtime offline" }),
    );
    await expect(resolveRuntimeModels("runtime-1")).rejects.toThrow("runtime offline");
  });

  it("does not start discovery for an offline runtime", () => {
    const options = runtimeModelsOptions("ws-1", "runtime-1", false);
    expect(options.enabled).toBe(false);
    expect(options.queryKey).toEqual(["runtimes", "ws-1", "models", "runtime-1"]);
  });
});

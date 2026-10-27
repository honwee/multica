// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getBuildServerConfig } from "@/lib/server-config";
import { useServerStore } from "./server-store";

const storageMock = vi.hoisted(() => ({
  readServerConfig: vi.fn(),
  writeServerConfig: vi.fn(),
}));

vi.mock("./server-storage", () => storageMock);

beforeEach(() => {
  vi.resetAllMocks();
  useServerStore.setState({
    ...getBuildServerConfig(),
    isInitialized: false,
  });
  storageMock.readServerConfig.mockResolvedValue(null);
  storageMock.writeServerConfig.mockResolvedValue(undefined);
});

describe("mobile server store", () => {
  it("restores the persisted deployment before auth restores its token", async () => {
    storageMock.readServerConfig.mockResolvedValue(JSON.stringify({
      apiUrl: "https://api.example.test/",
      webUrl: "https://app.example.test/",
    }));

    await useServerStore.getState().initialize();

    expect(useServerStore.getState()).toMatchObject({
      apiUrl: "https://api.example.test",
      webUrl: "https://app.example.test",
      isInitialized: true,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["an invalid persisted URL", JSON.stringify({
      apiUrl: "multica://auth/callback",
      webUrl: "https://app.example.test",
    })],
    ["an unavailable store", null],
  ])("falls back to the build environment for %s", async (_name, stored) => {
    if (stored === null) {
      storageMock.readServerConfig.mockRejectedValue(new Error("Unavailable"));
    } else {
      storageMock.readServerConfig.mockResolvedValue(stored);
    }

    await useServerStore.getState().initialize();

    expect(useServerStore.getState()).toMatchObject({
      ...getBuildServerConfig(),
      isInitialized: true,
    });
  });

  it("persists normalized origins before exposing them to requests", async () => {
    await useServerStore.getState().save({
      apiUrl: " https://api.example.test/ ",
      webUrl: " https://app.example.test/ ",
    });

    const expected = {
      apiUrl: "https://api.example.test",
      webUrl: "https://app.example.test",
    };
    expect(storageMock.writeServerConfig).toHaveBeenCalledWith(expected);
    expect(useServerStore.getState()).toMatchObject(expected);
  });

  it("does not activate a configuration that could not be persisted", async () => {
    const previous = getBuildServerConfig();
    storageMock.writeServerConfig.mockRejectedValue(new Error("Full"));

    await expect(useServerStore.getState().save({
      apiUrl: "https://api.example.test",
      webUrl: "https://app.example.test",
    })).rejects.toThrow("Full");

    expect(useServerStore.getState()).toMatchObject(previous);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedUser } from "./auth-cache";

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storage,
}));

describe("cached mobile identity", () => {
  beforeEach(() => {
    storage.getItem.mockReset();
  });

  it("returns null for malformed storage", async () => {
    storage.getItem.mockResolvedValue("not-json");
    await expect(readCachedUser()).resolves.toBeNull();
  });

  it("returns null for an invalid cached user", async () => {
    storage.getItem.mockResolvedValue(JSON.stringify({ name: "Missing id" }));
    await expect(readCachedUser()).resolves.toBeNull();
  });

  it("restores a valid cached user", async () => {
    storage.getItem.mockResolvedValue(
      JSON.stringify({ id: "user-1", name: "Cached", email: "cached@example.test" }),
    );
    await expect(readCachedUser()).resolves.toMatchObject({
      id: "user-1",
      name: "Cached",
    });
  });
});

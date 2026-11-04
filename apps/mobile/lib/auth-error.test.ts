// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { mapFeishuAuthError } from "./auth-error";

describe("mapFeishuAuthError", () => {
  it("uses the localized connectivity recovery message", () => {
    const translate = vi.fn((key: string) => `translated:${key}`);

    expect(
      mapFeishuAuthError(
        new TypeError("Network request failed"),
        "Feishu sign-in failed",
        translate,
      ),
    ).toBe("translated:verify.network");
  });

  it("does not expose raw provider or server details", () => {
    expect(
      mapFeishuAuthError(
        new Error("upstream Feishu provider detail"),
        "Feishu sign-in failed",
      ),
    ).toBe("Feishu sign-in failed");
    expect(mapFeishuAuthError(undefined, "Feishu sign-in failed")).toBe(
      "Feishu sign-in failed",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectToNativeAuth } from "./native-handoff";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("redirectToNativeAuth", () => {
  it("posts the token to the same-origin HTTP handoff", () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => undefined);

    redirectToNativeAuth(" native-jwt-with_symbols ");

    expect(submit).toHaveBeenCalledOnce();
    const form = document.querySelector("form");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(form?.getAttribute("action")).toBe("/auth/native");
    expect(form?.querySelector("input")?.value).toBe("native-jwt-with_symbols");
  });

  it("refuses an empty token", () => {
    expect(() => redirectToNativeAuth(" ")).toThrow("Missing native auth token");
    expect(document.querySelector("form")).toBeNull();
  });
});

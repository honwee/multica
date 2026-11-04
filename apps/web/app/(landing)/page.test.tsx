import { describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import LandingPage from "./page";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

describe("LandingPage", () => {
  it("redirects the homepage to the login page", () => {
    LandingPage();
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});

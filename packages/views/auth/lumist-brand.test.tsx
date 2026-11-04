import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LumistBrand } from "./lumist-brand";

vi.mock("@multica/ui/components/common/multica-icon", () => ({
  MulticaIcon: () => <span data-testid="multica-mark" />,
}));

describe("LumistBrand", () => {
  it("renders the organization logo and preserves the Multica mark", () => {
    render(<LumistBrand logo={<img src="/lumist.png" alt="路觅教育" />} />);

    expect(screen.getByRole("img", { name: "路觅教育" })).toBeInTheDocument();
    expect(screen.getByTestId("multica-mark")).toBeInTheDocument();
  });
});

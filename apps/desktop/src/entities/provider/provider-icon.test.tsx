import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./provider-icon";

describe("ProviderIcon", () => {
  it("renders an initial-letter fallback for an unknown provider id", () => {
    render(<ProviderIcon providerId="not-a-real-provider" />);

    expect(screen.getByTestId("provider-icon-not-a-real-provider")).toHaveTextContent(
      "N",
    );
  });

  it("uses the label's first letter when one is provided", () => {
    render(<ProviderIcon providerId="unknown" label="Radius" />);

    expect(screen.getByTestId("provider-icon-unknown")).toHaveTextContent("R");
  });
});

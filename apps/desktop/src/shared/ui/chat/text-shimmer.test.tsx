import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";

describe("TextShimmer", () => {
  it("renders its text with the shimmer slot and class", () => {
    render(<TextShimmer>Pace</TextShimmer>);

    const shimmer = screen.getByText("Pace");

    expect(shimmer).toHaveAttribute("data-slot", "text-shimmer");
    expect(shimmer).toHaveClass("text-shimmer");
  });

  it("appends caller class names", () => {
    render(<TextShimmer className="custom">Loading</TextShimmer>);

    expect(screen.getByText("Loading")).toHaveClass("text-shimmer", "custom");
  });

  it("defaults to the default tone without the brand class", () => {
    render(<TextShimmer>Pace</TextShimmer>);

    const shimmer = screen.getByText("Pace");

    expect(shimmer).toHaveAttribute("data-tone", "default");
    expect(shimmer).not.toHaveClass("text-shimmer--brand");
  });

  it("renders the brand tone with its own class and data attribute", () => {
    render(<TextShimmer tone="brand">Pace</TextShimmer>);

    const shimmer = screen.getByText("Pace");

    expect(shimmer).toHaveClass("text-shimmer", "text-shimmer--brand");
    expect(shimmer).toHaveAttribute("data-tone", "brand");
  });
});

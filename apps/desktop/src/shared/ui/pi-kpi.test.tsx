import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PiKpi } from "@/shared/ui/pi-kpi";

describe("PiKpi", () => {
  it("renders a labeled stat tile with an Intl-formatted value", () => {
    render(
      <PiKpi
        formatOptions={{
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }}
        label="Total cost"
        value={12.3456}
      />,
    );

    const kpi = screen.getByText("Total cost").closest('[data-slot="kpi"]');

    expect(kpi).not.toBeNull();
    expect(screen.getByText("$12.35")).toBeInTheDocument();
  });

  it("renders compact-notation numbers", () => {
    render(
      <PiKpi
        formatOptions={{ notation: "compact", maximumFractionDigits: 1 }}
        label="Total tokens"
        value={18_420}
      />,
    );

    expect(screen.getByText("18.4K")).toBeInTheDocument();
  });

  it("renders custom value nodes instead of a number", () => {
    render(
      <PiKpi label="Primary model" valueTestId="session-primary-model-value">
        gpt-5-codex
      </PiKpi>,
    );

    const value = screen.getByTestId("session-primary-model-value");

    expect(value).toHaveTextContent("gpt-5-codex");
    expect(value).toHaveAttribute("data-slot", "kpi-value");
  });

  it("supports an inline layout and an optional delta", () => {
    render(
      <PiKpi delta="+12%" label="Sessions" layout="inline" value={4} />,
    );

    const kpi = screen.getByText("Sessions").closest('[data-slot="kpi"]');

    expect(kpi).toHaveClass("pi-kpi--inline");
    expect(screen.getByText("+12%")).toHaveAttribute("data-slot", "kpi-delta");
  });
});

describe("PiKpi footer", () => {
  it("renders an optional footer slot below the value row", () => {
    const { container, rerender } = render(<PiKpi footer={<span>spark</span>} label="Cost" value={1} />);

    expect(container.querySelector('[data-slot="kpi-footer"]')).toHaveTextContent("spark");

    rerender(<PiKpi label="Cost" value={1} />);
    expect(container.querySelector('[data-slot="kpi-footer"]')).toBeNull();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PiLineChart, PiSparkline } from "@/shared/ui/pi-line-chart";

const points = [
  { key: "2026-06-25", label: "Jun 25", value: 4 },
  { key: "2026-06-26", label: "Jun 26", value: 0 },
  { key: "2026-06-27", label: "Jun 27", value: 2.5 },
];

describe("PiLineChart", () => {
  it("renders a labeled image with one path and axis labels once measured", async () => {
    const { container } = render(
      <PiLineChart aria-label="Daily cost" points={points} valueFormatter={(v) => `$${v}`} />,
    );

    expect(screen.getByRole("img", { name: "Daily cost" })).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('[data-slot="line-chart-line"]')).toBeInTheDocument());
    expect(screen.getByText("Jun 25")).toBeInTheDocument();
    expect(screen.getByText("Jun 27")).toBeInTheDocument();
  });

  it("shows the empty label instead of a plot when there are no points", () => {
    const { container } = render(
      <PiLineChart aria-label="Daily cost" emptyLabel="No usage in this range" points={[]} />,
    );

    expect(screen.getByText("No usage in this range")).toHaveAttribute("data-slot", "line-chart-empty");
    expect(container.querySelector('[data-slot="line-chart-line"]')).toBeNull();
  });

  it("reveals the nearest point's tooltip on hover and hides it on leave", async () => {
    const { container } = render(
      <PiLineChart
        aria-label="Daily cost"
        points={points}
        renderTooltip={(point) => <span>{point.label} tooltip</span>}
      />,
    );
    const root = container.querySelector('[data-slot="line-chart"]')!;
    await waitFor(() => expect(container.querySelector('[data-slot="line-chart-line"]')).toBeInTheDocument());

    expect(container.querySelector('[data-slot="line-chart-tooltip"]')).toBeNull();
    fireEvent.mouseMove(root, { clientX: 10_000, clientY: 10 });
    expect(container.querySelector('[data-slot="line-chart-tooltip"]')).toHaveTextContent("Jun 27 tooltip");
    fireEvent.mouseLeave(root);
    expect(container.querySelector('[data-slot="line-chart-tooltip"]')).toBeNull();
  });
});

describe("PiSparkline", () => {
  it("renders a decorative polyline for two or more values and nothing for fewer", () => {
    const { container, rerender } = render(<PiSparkline values={[1, 3, 2]} />);

    expect(container.querySelector("polyline")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    rerender(<PiSparkline values={[1]} />);
    expect(container.querySelector("polyline")).toBeNull();
  });
});

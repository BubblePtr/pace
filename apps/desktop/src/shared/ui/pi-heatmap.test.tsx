import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PiHeatmap } from "@/shared/ui/pi-heatmap";

const rows = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
];
const columns = [{ key: "0", label: "00:00" }, { key: "1" }, { key: "2", label: "02:00" }];

describe("PiHeatmap", () => {
  it("renders one cell per row × column with its level and accessible label", () => {
    const { container } = render(
      <PiHeatmap
        aria-label="Rhythm"
        cellLabel={(row, column, value) => `${row.label} ${column.key}: ${value}`}
        columns={columns}
        levelOf={(value) => (value === 0 ? 0 : value > 5 ? 5 : 1)}
        rows={rows}
        values={[
          [0, 1, 9],
          [2, 0, 0],
        ]}
      />,
    );

    const cells = container.querySelectorAll('[data-slot="heatmap-cell"]');
    expect(cells).toHaveLength(6);
    expect(screen.getByRole("img", { name: "Mon 2: 9" })).toHaveAttribute("data-level", "5");
    expect(screen.getByRole("img", { name: "Tue 1: 0" })).toHaveAttribute("data-level", "0");
    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.getByText("02:00")).toBeInTheDocument();
  });

  it("shows the tooltip for the hovered cell only", () => {
    const { container } = render(
      <PiHeatmap
        aria-label="Rhythm"
        cellLabel={(row, column) => `${row.key}-${column.key}`}
        columns={columns}
        levelOf={() => 1}
        renderTooltip={(row, column, value) => <span>{`${row.label} ${column.key} = ${value}`}</span>}
        rows={rows}
        values={[
          [1, 2, 3],
          [4, 5, 6],
        ]}
      />,
    );

    expect(container.querySelector('[data-slot="heatmap-tooltip"]')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("img", { name: "tue-2" }));
    expect(container.querySelector('[data-slot="heatmap-tooltip"]')).toHaveTextContent("Tue 2 = 6");
    fireEvent.mouseLeave(screen.getByRole("img", { name: "tue-2" }));
    expect(container.querySelector('[data-slot="heatmap-tooltip"]')).toBeNull();
  });
});

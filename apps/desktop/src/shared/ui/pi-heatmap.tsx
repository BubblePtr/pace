import { useState, type ComponentProps, type ReactNode } from "react";

export type PiHeatmapAxisItem = { key: string; label?: string };

type PiHeatmapOwnProps<R extends PiHeatmapAxisItem, C extends PiHeatmapAxisItem> = {
  "aria-label": string;
  rows: R[];
  columns: C[];
  /** `values[rowIndex][columnIndex]`. */
  values: number[][];
  /** Maps a value to a sequential level 0..5 (0 = empty). */
  levelOf: (value: number) => number;
  /** Accessible name for each cell. */
  cellLabel: (row: R, column: C, value: number) => string;
  /** Tooltip body for the hovered cell; omit for no tooltip. */
  renderTooltip?: (row: R, column: C, value: number) => ReactNode;
};

export type PiHeatmapProps<R extends PiHeatmapAxisItem, C extends PiHeatmapAxisItem> = Omit<
  ComponentProps<"div">,
  keyof PiHeatmapOwnProps<R, C> | "children"
> &
  PiHeatmapOwnProps<R, C>;

/**
 * Row × column grid with one sequential hue (levels 0..5, colour derived
 * from `--pigui-data-blue` in primitives.css). Cells stretch to the
 * container width; row labels sit in a leading column, column labels in a
 * trailing row.
 */
export function PiHeatmap<R extends PiHeatmapAxisItem, C extends PiHeatmapAxisItem>({
  "aria-label": ariaLabel,
  rows,
  columns,
  values,
  levelOf,
  cellLabel,
  renderTooltip,
  className = "",
  ...rest
}: PiHeatmapProps<R, C>) {
  const [hover, setHover] = useState<{ row: number; column: number; x: number; y: number } | null>(null);
  const active = hover ? { row: rows[hover.row], column: columns[hover.column], value: values[hover.row]?.[hover.column] ?? 0 } : null;

  return (
    <div
      aria-label={ariaLabel}
      className={`pi-heatmap ${className}`.trim()}
      data-slot="heatmap"
      role="group"
      style={{ "--pi-heatmap-columns": columns.length } as React.CSSProperties}
      {...rest}
    >
      <div className="pi-heatmap__grid">
        {rows.map((row, rowIndex) => (
          <div key={row.key} className="pi-heatmap__row">
            <span aria-hidden className="pi-heatmap__row-label">
              {row.label ?? ""}
            </span>
            {columns.map((column, columnIndex) => {
              const value = values[rowIndex]?.[columnIndex] ?? 0;
              return (
                <span
                  key={column.key}
                  aria-label={cellLabel(row, column, value)}
                  className="pi-heatmap__cell"
                  data-level={levelOf(value)}
                  data-slot="heatmap-cell"
                  role="img"
                  onMouseEnter={(event) => {
                    const cell = event.currentTarget.getBoundingClientRect();
                    const root = event.currentTarget.closest('[data-slot="heatmap"]')!.getBoundingClientRect();
                    setHover({ row: rowIndex, column: columnIndex, x: cell.left - root.left + cell.width / 2, y: cell.top - root.top });
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })}
          </div>
        ))}
        <div className="pi-heatmap__row">
          <span aria-hidden className="pi-heatmap__row-label" />
          {columns.map((column) => (
            <span key={column.key} aria-hidden className="pi-heatmap__column-label">
              {column.label ?? ""}
            </span>
          ))}
        </div>
      </div>
      {active && renderTooltip ? (
        <div
          className="pi-chart-tooltip"
          data-slot="heatmap-tooltip"
          style={{
            left: hover!.x,
            top: hover!.y,
            transform: hover!.column > columns.length * 0.66 ? "translate(calc(-100% - var(--spacing-2)), calc(-100% - var(--spacing-2)))" : "translate(var(--spacing-2), calc(-100% - var(--spacing-2)))",
          }}
        >
          {renderTooltip(active.row, active.column, active.value)}
        </div>
      ) : null}
    </div>
  );
}

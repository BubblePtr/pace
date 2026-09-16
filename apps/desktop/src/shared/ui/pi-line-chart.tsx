import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

export type PiLinePoint = {
  key: string;
  /** Axis tick label. */
  label: string;
  value: number;
};

type PiLineChartOwnProps = {
  "aria-label": string;
  points: PiLinePoint[];
  /** Plot height in pixels; the width follows the container. */
  height?: number;
  /** Series colour; only `--pigui-data-*` tokens. */
  color?: string;
  valueFormatter?: (value: number) => string;
  /** Tooltip body for the hovered point; omit for no tooltip. */
  renderTooltip?: (point: PiLinePoint) => ReactNode;
  /** Shown instead of the plot when `points` is empty. */
  emptyLabel?: string;
};

export type PiLineChartProps = Omit<ComponentProps<"div">, keyof PiLineChartOwnProps | "children"> &
  PiLineChartOwnProps;

const pad = { top: 12, right: 12, bottom: 24, left: 44 };

function niceCeil(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const unit = value / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/** Container width via ResizeObserver so the SVG can use real pixel geometry. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Single-series line with crosshair hover, hand-rolled on Astryx tokens.
 * Layout divs are intentional and contained to this component.
 */
export function PiLineChart({
  "aria-label": ariaLabel,
  points,
  height = 220,
  color = "var(--pigui-data-blue)",
  valueFormatter = (value) => String(value),
  renderTooltip,
  emptyLabel = "No data yet",
  className = "",
  ...rest
}: PiLineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const count = points.length;
  const plotWidth = Math.max(0, width - pad.left - pad.right);
  const plotHeight = height - pad.top - pad.bottom;
  const max = niceCeil(Math.max(...points.map((p) => p.value), 0));
  const x = (index: number) => pad.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) => pad.top + plotHeight - (value / max) * plotHeight;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area =
    count > 1
      ? `${line} L${x(count - 1).toFixed(1)},${(pad.top + plotHeight).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + plotHeight).toFixed(1)} Z`
      : "";
  const labelEvery = Math.max(1, Math.ceil(count / 6));
  const active = hover === null ? null : points[hover];

  return (
    <div
      ref={ref}
      aria-label={ariaLabel}
      className={`pi-line-chart ${className}`.trim()}
      data-slot="line-chart"
      role="img"
      style={{ height }}
      onMouseLeave={() => setHover(null)}
      onMouseMove={(event) => {
        if (count === 0 || plotWidth <= 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - rect.left - pad.left) / plotWidth;
        setHover(Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1)))));
      }}
      {...rest}
    >
      {count === 0 ? (
        <span className="pi-line-chart__empty" data-slot="line-chart-empty">
          {emptyLabel}
        </span>
      ) : null}
      {count > 0 && width > 0 ? (
        <svg aria-hidden className="pi-line-chart__svg" height={height} width={width}>
          {[0, max / 2, max].map((tick) => (
            <g key={tick}>
              <line
                className="pi-line-chart__grid"
                strokeDasharray={tick === 0 ? undefined : "2 4"}
                x1={pad.left}
                x2={width - pad.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="pi-line-chart__tick" dominantBaseline="middle" textAnchor="end" x={pad.left - 8} y={y(tick)}>
                {valueFormatter(tick)}
              </text>
            </g>
          ))}
          {points.map((point, index) =>
            index % labelEvery === 0 || index === count - 1 ? (
              <text
                key={point.key}
                className="pi-line-chart__tick"
                textAnchor={index === count - 1 ? "end" : index === 0 ? "start" : "middle"}
                x={x(index)}
                y={height - 6}
              >
                {point.label}
              </text>
            ) : null,
          )}
          {count > 1 ? <path className="pi-line-chart__area" d={area} fill={color} /> : null}
          <path className="pi-line-chart__line" d={line} data-slot="line-chart-line" fill="none" stroke={color} />
          {hover !== null && active ? (
            <g>
              <line className="pi-line-chart__crosshair" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotHeight} />
              <circle className="pi-line-chart__marker" cx={x(hover)} cy={y(active.value)} fill={color} r={4} />
            </g>
          ) : null}
        </svg>
      ) : null}
      {active && renderTooltip ? (
        <div
          className="pi-chart-tooltip"
          data-slot="line-chart-tooltip"
          style={{
            left: x(hover!),
            top: pad.top,
            transform: x(hover!) > width * 0.65 ? "translateX(calc(-100% - var(--spacing-3)))" : "translateX(var(--spacing-3))",
          }}
        >
          {renderTooltip(active)}
        </div>
      ) : null}
    </div>
  );
}

export type PiSparklineProps = Omit<ComponentProps<"div">, "children"> & {
  values: number[];
  color?: string;
  height?: number;
};

/** Decorative trend line for KPI tiles; no axes, no tooltip, aria-hidden. */
export function PiSparkline({
  values,
  color = "var(--pigui-data-blue)",
  height = 36,
  className = "",
  ...rest
}: PiSparklineProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const max = Math.max(...values, 0);
  const count = values.length;
  // Without a measured width (first paint, jsdom) draw in a 100-unit box
  // and let preserveAspectRatio stretch it; the line is decorative.
  const drawWidth = width || 100;
  const points = values.map((value, index) => {
    const px = count === 1 ? drawWidth / 2 : (index / (count - 1)) * drawWidth;
    const py = max === 0 ? height - 1 : height - 1 - (value / max) * (height - 2);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });

  return (
    <div ref={ref} className={`pi-sparkline ${className}`.trim()} data-slot="sparkline" style={{ height }} {...rest}>
      {count > 1 ? (
        <svg aria-hidden="true" height={height} preserveAspectRatio="none" viewBox={`0 0 ${drawWidth} ${height}`} width="100%">
          <polyline className="pi-sparkline__line" fill="none" points={points.join(" ")} stroke={color} />
        </svg>
      ) : null}
    </div>
  );
}

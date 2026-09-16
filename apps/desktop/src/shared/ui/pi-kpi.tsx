import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import type { ComponentProps, ReactNode } from "react";

type PiKpiOwnProps = {
  /** Stat label, e.g. "Total cost". */
  label: string;
  /** Numeric stat value, formatted with Intl.NumberFormat. */
  value?: number;
  /** Intl.NumberFormat options for `value` (currency, compact notation, ...). */
  formatOptions?: Intl.NumberFormatOptions;
  /** Optional trend/delta annotation rendered after the value. */
  delta?: ReactNode;
  /** Optional slot below the value row, e.g. a PiSparkline. */
  footer?: ReactNode;
  /** stacked = label above value (dashboard tile); inline = label and value on one row. */
  layout?: "stacked" | "inline";
  /** Custom value node; replaces the formatted `value`. */
  children?: ReactNode;
  valueClassName?: string;
  valueTestId?: string;
};

export type PiKpiProps = Omit<ComponentProps<typeof Card>, keyof PiKpiOwnProps> & PiKpiOwnProps;

/**
 * Stat tile (label + value + optional delta) on Astryx Card/Text tokens.
 */
export function PiKpi({
  label,
  value,
  formatOptions,
  delta,
  footer,
  layout = "stacked",
  children,
  valueClassName = "",
  valueTestId,
  className,
  ...rest
}: PiKpiProps) {
  const formattedValue =
    typeof value === "number"
      ? new Intl.NumberFormat(undefined, formatOptions).format(value)
      : null;

  return (
    <Card className={className} padding={4} {...rest}>
      <dl className={`pi-kpi pi-kpi--${layout}`} data-slot="kpi">
        <Text as="span" color="secondary" type="supporting">
          <dt className="pi-kpi__label">{label}</dt>
        </Text>
        <dd className="pi-kpi__value-row">
          <span
            className={`pi-kpi__value ${valueClassName}`.trim()}
            data-slot="kpi-value"
            {...(valueTestId ? { "data-testid": valueTestId } : {})}
          >
            {children ?? formattedValue}
          </span>
          {delta !== undefined && delta !== null ? (
            <span className="pi-kpi__delta" data-slot="kpi-delta">
              {delta}
            </span>
          ) : null}
        </dd>
        {footer !== undefined && footer !== null ? (
          <dd className="pi-kpi__footer" data-slot="kpi-footer">
            {footer}
          </dd>
        ) : null}
      </dl>
    </Card>
  );
}

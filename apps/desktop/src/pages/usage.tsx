import { useQuery } from "@tanstack/react-query";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useMemo, useState, type ReactNode } from "react";
import { AppFrame } from "@/app/app-shell";
import { RefreshCw } from "@/shared/ui/icons";
import { PiHeatmap } from "@/shared/ui/pi-heatmap";
import { PiKpi } from "@/shared/ui/pi-kpi";
import { PiLineChart, PiSparkline, type PiLinePoint } from "@/shared/ui/pi-line-chart";
import { useRefreshOnWindowFocus } from "@/shared/refresh";
import {
  formatDateLabel,
  formatTokens,
  listSessions,
  type NamedCount,
  type SessionSummary,
} from "@/entities/session/sessions";
import {
  aggregateDailyCost,
  aggregateSkillCounts,
  aggregateToolCounts,
  aggregateWeekdayHourCost,
  localClock,
  rankLevels,
  rankModelsByCost,
  rankProjectsByCost,
  splitUsagePeriod,
  summarizeUsage,
  usageDelta,
  usagePeriods,
  type DailyCost,
  type LocalClock,
  type UsageDelta,
  type UsagePeriod,
  type UsageRank,
} from "@/entities/session/usage-aggregation";

// Cost is the page's primary axis. Categorical series colours are assigned
// in this fixed order by rank and never cycled; a sixth entity folds into
// "Other" (slate). Series colour is only ever a `--pigui-data-*` token.
const seriesColors = [
  "var(--pigui-data-blue)",
  "var(--pigui-data-orange)",
  "var(--pigui-data-green)",
  "var(--pigui-data-amber)",
  "var(--pigui-data-coral)",
] as const;
const otherColor = "var(--pigui-data-slate)";
const trendColor = seriesColors[0];
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const hours = Array.from({ length: 24 }, (_, hour) => ({
  key: String(hour),
  label: hour % 6 === 0 ? `${String(hour).padStart(2, "0")}:00` : undefined,
}));

function colorByRank(names: string[]) {
  const map = new Map(names.map((name, index) => [name, seriesColors[index] ?? otherColor]));
  return (name: string) => map.get(name) ?? otherColor;
}

function money(value: number, digits = 2) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Two decimals for headlines; sub-cent costs read as "<$0.01" instead of "$0.00". */
function moneyAuto(value: number) {
  return value > 0 && value < 0.01 ? `<${money(0.01)}` : money(value);
}

function percent(value: number) {
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(value);
}

function shortProject(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function deltaLabel(delta: UsageDelta | null, days: number | null) {
  if (!delta || days === null) return null;
  if (delta.kind === "new") return `no usage in previous ${days} days`;
  if (delta.kind === "flat") return `no change vs previous ${days} days`;
  return `${delta.ratio > 0 ? "+" : ""}${percent(delta.ratio)} vs previous ${days} days`;
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function UsageWidget({
  title,
  meta,
  actions,
  children,
}: {
  title: string;
  meta: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card padding={4}>
      <section aria-label={title} className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <Heading level={2}>{title}</Heading>
            <Text color="secondary" display="block" type="supporting">
              {meta}
            </Text>
          </div>
          {actions}
        </div>
        {children}
      </section>
    </Card>
  );
}

function UsageKpi({
  label,
  value,
  delta,
  spark,
}: {
  label: string;
  value: string;
  delta: string | null;
  spark: number[];
}) {
  return (
    <PiKpi
      delta={delta}
      footer={<PiSparkline color={trendColor} values={spark} />}
      label={label}
    >
      {value}
    </PiKpi>
  );
}

function CostTrendTooltip({ day, colorFor }: { day: DailyCost; colorFor: (project: string) => string }) {
  return (
    <>
      <Text as="p" color="primary" display="block" type="supporting" weight="medium">
        {formatDateLabel(day.date)} · {day.sessions} {day.sessions === 1 ? "session" : "sessions"}
      </Text>
      <Text as="p" display="block" hasTabularNumbers type="body" weight="semibold">
        {money(day.costUsd)}
      </Text>
      {day.projects.slice(0, 4).map((project) => (
        <div key={project.project} className="flex items-center justify-between gap-4">
          <span className="flex min-w-0 items-center gap-1.5">
            <Swatch color={colorFor(project.project)} />
            <Text maxLines={1} type="supporting">
              {shortProject(project.project)}
            </Text>
          </span>
          <Text hasTabularNumbers type="supporting">
            {money(project.costUsd)}
          </Text>
        </div>
      ))}
    </>
  );
}

/** Edge-to-edge rank rows: name, proportional bar, value. Never card-wrapped. */
function RankRows({
  rows,
  colorFor,
  label = (row) => row.name,
  meta,
  emptyLabel,
}: {
  rows: UsageRank[];
  colorFor: (name: string) => string;
  label?: (row: UsageRank) => string;
  meta: (row: UsageRank) => string;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <EmptyState isCompact title={emptyLabel} />;
  }
  const max = Math.max(...rows.map((row) => row.costUsd), 0);

  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map((row) => (
        <li
          key={row.name}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-separator py-2 last:border-b-0"
          title={row.name}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Swatch color={colorFor(row.name)} />
            <Text maxLines={1} type="body" weight="medium">
              {label(row)}
            </Text>
          </span>
          <Text hasTabularNumbers justify="end" type="body" weight="semibold">
            {moneyAuto(row.costUsd)}
          </Text>
          <span className="col-span-2 flex items-center gap-3">
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-muted">
              <span
                className="block h-full rounded-full"
                style={{ backgroundColor: colorFor(row.name), width: `${max === 0 ? 0 : (row.costUsd / max) * 100}%` }}
              />
            </span>
            <Text hasTabularNumbers type="supporting">
              {meta(row)}
            </Text>
          </span>
        </li>
      ))}
    </ul>
  );
}

function CountRows({ items, emptyLabel }: { items: NamedCount[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <EmptyState isCompact title={emptyLabel} />;
  }
  const max = Math.max(...items.map((item) => item.count), 0);

  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {items.map((item) => (
        <li
          key={item.name}
          className="grid grid-cols-[minmax(0,1fr)_6rem_3.5rem] items-center gap-3 border-b border-separator py-1.5 last:border-b-0"
        >
          <Text maxLines={1} type="body">
            {item.name}
          </Text>
          <span aria-hidden className="h-1 overflow-hidden rounded-full bg-surface-muted">
            <span
              className="block h-full rounded-full"
              style={{ backgroundColor: otherColor, width: `${max === 0 ? 0 : (item.count / max) * 100}%` }}
            />
          </span>
          <Text hasTabularNumbers justify="end" type="body" weight="medium">
            {item.count}
          </Text>
        </li>
      ))}
    </ul>
  );
}

export function UsageDashboard({
  sessions,
  clock = localClock,
  isFetching = false,
  onRefresh,
}: {
  sessions: SessionSummary[];
  /** Weekday/hour resolver for the rhythm grid; defaults to the local clock. */
  clock?: LocalClock;
  isFetching?: boolean;
  onRefresh?: () => void;
}) {
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const spec = usagePeriods.find((item) => item.id === period) ?? usagePeriods[1];
  const { current, previous } = useMemo(() => splitUsagePeriod(sessions, period), [sessions, period]);
  const summary = summarizeUsage(current.sessions);
  const previousSummary = previous ? summarizeUsage(previous.sessions) : null;
  const days = useMemo(() => aggregateDailyCost(current), [current]);
  const projects = useMemo(() => rankProjectsByCost(current.sessions), [current]);
  const models = useMemo(() => rankModelsByCost(current.sessions), [current]);
  const tools = useMemo(() => aggregateToolCounts(current.sessions), [current]);
  const skills = useMemo(() => aggregateSkillCounts(current.sessions), [current]);
  const rhythm = useMemo(() => aggregateWeekdayHourCost(current.sessions, clock), [current, clock]);
  const rhythmLevel = useMemo(() => rankLevels(rhythm.flat().map((cell) => cell.costUsd)), [rhythm]);
  const projectColor = useMemo(() => colorByRank(projects.map((row) => row.name)), [projects]);
  const modelColor = useMemo(() => colorByRank(models.map((row) => row.name)), [models]);
  const trend = useMemo<PiLinePoint[]>(
    () => days.map((day) => ({ key: day.date, label: formatDateLabel(day.date), value: day.costUsd })),
    [days],
  );
  const dayByKey = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);
  const averageCost = summary.sessions === 0 ? 0 : summary.costUsd / summary.sessions;
  const previousAverage =
    previousSummary === null ? null : previousSummary.sessions === 0 ? 0 : previousSummary.costUsd / previousSummary.sessions;
  const scope = spec.days === null ? "all time" : "this period";

  if (sessions.length === 0) {
    return (
      <EmptyState
        className="px-4 py-12"
        description="Usage appears here once a Pi session has run. Start one from Trajectory."
        title="No sessions recorded yet"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text color="secondary" display="block" hasTabularNumbers type="body">
          {current.start === current.end
            ? formatDateLabel(current.start)
            : `${formatDateLabel(current.start)} – ${formatDateLabel(current.end)}`}
        </Text>
        <div className="flex items-center gap-2">
          <SegmentedControl
            label="Usage period"
            size="sm"
            value={period}
            onChange={(value) => setPeriod(usagePeriods.some((item) => item.id === value) ? (value as UsagePeriod) : "30d")}
          >
            {usagePeriods.map((item) => (
              <SegmentedControlItem key={item.id} label={item.label} value={item.id} />
            ))}
          </SegmentedControl>
          {onRefresh ? (
            <span className="inline-flex" data-testid="usage-refresh-tooltip-trigger">
              <IconButton
                className="pigui-pressable"
                icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />}
                isDisabled={isFetching}
                label="Refresh usage"
                size="sm"
                tooltip="Refresh usage data"
                variant="ghost"
                onClick={onRefresh}
              />
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <UsageKpi
          delta={deltaLabel(usageDelta(summary.costUsd, previousSummary?.costUsd ?? null), spec.days)}
          label="Cost"
          spark={days.map((day) => day.costUsd)}
          value={money(summary.costUsd)}
        />
        <UsageKpi
          delta={deltaLabel(usageDelta(summary.tokens, previousSummary?.tokens ?? null), spec.days)}
          label="Tokens"
          spark={days.map((day) => day.tokens)}
          value={formatTokens(summary.tokens)}
        />
        <UsageKpi
          delta={deltaLabel(usageDelta(summary.sessions, previousSummary?.sessions ?? null), spec.days)}
          label="Sessions"
          spark={days.map((day) => day.sessions)}
          value={String(summary.sessions)}
        />
        <UsageKpi
          delta={deltaLabel(usageDelta(averageCost, previousAverage), spec.days)}
          label="Avg cost / session"
          spark={days.map((day) => (day.sessions === 0 ? 0 : day.costUsd / day.sessions))}
          value={moneyAuto(averageCost)}
        />
      </div>

      <UsageWidget meta="Daily spend; hover for the project split" title="Cost over time">
        <PiLineChart
          aria-label="Daily cost"
          color={trendColor}
          emptyLabel="No sessions in this period"
          points={trend}
          renderTooltip={(point) => {
            const day = dayByKey.get(point.key);
            return day ? <CostTrendTooltip colorFor={projectColor} day={day} /> : null;
          }}
          valueFormatter={(value) => money(value, value >= 10 ? 0 : 1)}
        />
        {projects.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {projects.slice(0, seriesColors.length).map((project) => (
              <span key={project.name} className="inline-flex items-center gap-1.5" title={project.name}>
                <Swatch color={projectColor(project.name)} />
                <Text type="supporting">{shortProject(project.name)}</Text>
              </span>
            ))}
            {projects.length > seriesColors.length ? (
              <span className="inline-flex items-center gap-1.5">
                <Swatch color={otherColor} />
                <Text type="supporting">Other ({projects.length - seriesColors.length})</Text>
              </span>
            ) : null}
          </div>
        ) : null}
      </UsageWidget>

      <UsageWidget
        actions={
          <div className="flex items-center gap-2">
            <Text color="secondary" type="supporting">
              Less
            </Text>
            {[0, 1, 2, 3, 4, 5].map((level) => (
              <span key={level} aria-hidden className="pi-heatmap__cell inline-block w-3" data-level={level} />
            ))}
            <Text color="secondary" type="supporting">
              More
            </Text>
          </div>
        }
        meta={`Cost by weekday and hour, local time, ${scope}`}
        title="Rhythm"
      >
        <PiHeatmap
          aria-label="Cost by weekday and hour"
          cellLabel={(row, column, value) =>
            `${row.label} ${String(column.key).padStart(2, "0")}:00: ${
              value === 0 ? "no sessions" : `${money(value)}, ${rhythm[row.index][Number(column.key)].sessions} sessions`
            }`
          }
          columns={hours}
          levelOf={rhythmLevel}
          renderTooltip={(row, column, value) => {
            const hour = Number(column.key);
            const cell = rhythm[row.index][hour];
            return (
              <>
                <Text as="p" color="primary" display="block" type="supporting" weight="medium">
                  {row.label} · {String(hour).padStart(2, "0")}:00–{String((hour + 1) % 24).padStart(2, "0")}:00
                </Text>
                <Text as="p" display="block" hasTabularNumbers type="supporting">
                  {cell.sessions === 0 ? "No sessions" : `${money(value)} · ${cell.sessions} ${cell.sessions === 1 ? "session" : "sessions"}`}
                </Text>
              </>
            );
          }}
          rows={weekdays.map((label, index) => ({ key: label.toLowerCase(), label, index }))}
          values={rhythm.map((row) => row.map((cell) => cell.costUsd))}
        />
      </UsageWidget>

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageWidget meta={`Share of cost, ${scope}`} title="By project">
          <RankRows
            colorFor={projectColor}
            emptyLabel="No sessions in this period."
            label={(row) => shortProject(row.name)}
            meta={(row) => `${percent(row.share)} · ${row.sessions} ${row.sessions === 1 ? "session" : "sessions"}`}
            rows={projects}
          />
        </UsageWidget>
        <UsageWidget meta={`Cost and tokens per model, ${scope}`} title="By model">
          <RankRows
            colorFor={modelColor}
            emptyLabel="No model usage in this period."
            meta={(row) => `${percent(row.share)} · ${formatTokens(row.tokens)} tokens`}
            rows={models}
          />
        </UsageWidget>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageWidget meta={`Calls across sessions, ${scope}`} title="Tools">
          <CountRows emptyLabel="No tool calls in this period." items={tools} />
        </UsageWidget>
        <UsageWidget meta={`Invocations across sessions, ${scope}`} title="Skills">
          <CountRows emptyLabel="No skill usage in this period." items={skills} />
        </UsageWidget>
      </div>
    </div>
  );
}

export function UsagePage() {
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: listSessions,
  });

  useRefreshOnWindowFocus(sessions.refetch);

  return (
    <AppFrame>
      <article className="min-h-full px-6 py-6">
        <div className="mx-auto w-full max-w-6xl">
          {sessions.isError ? (
            <EmptyState className="px-4 py-12" title="Could not read the Pi agent directory." />
          ) : sessions.isLoading ? (
            <EmptyState className="px-4 py-12" title="Loading usage..." />
          ) : (
            <UsageDashboard
              isFetching={sessions.isFetching}
              sessions={sessions.data ?? []}
              onRefresh={() => sessions.refetch()}
            />
          )}
        </div>
      </article>
    </AppFrame>
  );
}

import type { NamedCount, SessionSummary } from "@/entities/session/sessions";

// Usage page read model. Cost (USD) is the primary axis; tokens ride along.
// Days are UTC calendar days everywhere except the weekday × hour grid,
// which takes a clock so the page can bucket in the user's local time.

export type UsagePeriod = "7d" | "30d" | "90d" | "all";

export const usagePeriods: ReadonlyArray<{ id: UsagePeriod; label: string; days: number | null }> = [
  { id: "7d", label: "7D", days: 7 },
  { id: "30d", label: "30D", days: 30 },
  { id: "90d", label: "90D", days: 90 },
  { id: "all", label: "All", days: null },
];

export type UsageWindow = {
  /** Inclusive UTC day, YYYY-MM-DD. */
  start: string;
  /** Inclusive UTC day, YYYY-MM-DD. */
  end: string;
  sessions: SessionSummary[];
};

export type UsageSummary = {
  costUsd: number;
  tokens: number;
  sessions: number;
  projects: number;
};

export type UsageDelta =
  | { ratio: number; kind: "up" | "down" | "flat" }
  | { ratio: null; kind: "new" };

export type DailyProjectCost = { project: string; costUsd: number };

export type DailyCost = {
  date: string;
  costUsd: number;
  tokens: number;
  sessions: number;
  /** Sorted by cost, descending. */
  projects: DailyProjectCost[];
};

export type UsageRank = {
  name: string;
  costUsd: number;
  tokens: number;
  sessions: number;
  /** Share of total cost across all ranks, 0..1. */
  share: number;
};

export type WeekdayHourCell = { costUsd: number; sessions: number };

export type LocalClock = (timestamp: string) => { weekday: number; hour: number };

const dayMs = 86_400_000;

function toUtcDay(timestamp: string) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function shiftUtcDay(day: string, days: number) {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * dayMs).toISOString().slice(0, 10);
}

function dayRange(start: string, end: string) {
  const days: string[] = [];
  for (let day = start; day <= end; day = shiftUtcDay(day, 1)) days.push(day);
  return days;
}

function latestUtcDay(sessions: SessionSummary[]) {
  return sessions.reduce<string | null>((latest, s) => {
    const day = toUtcDay(s.timestamp);
    return latest === null || day > latest ? day : latest;
  }, null);
}

function earliestUtcDay(sessions: SessionSummary[], fallback: string) {
  return sessions.reduce((earliest, s) => {
    const day = toUtcDay(s.timestamp);
    return day < earliest ? day : earliest;
  }, fallback);
}

/**
 * The selected window anchored on the latest recorded day, plus the
 * equally long window right before it (null for `all`).
 */
export function splitUsagePeriod(
  sessions: SessionSummary[],
  period: UsagePeriod,
): { current: UsageWindow; previous: UsageWindow | null } {
  const end = latestUtcDay(sessions) ?? "1970-01-01";
  const spec = usagePeriods.find((p) => p.id === period) ?? usagePeriods[1];

  if (spec.days === null) {
    return { current: { start: earliestUtcDay(sessions, end), end, sessions }, previous: null };
  }

  const start = shiftUtcDay(end, -(spec.days - 1));
  const previousEnd = shiftUtcDay(start, -1);
  const previousStart = shiftUtcDay(previousEnd, -(spec.days - 1));
  const within = (a: string, b: string) =>
    sessions.filter((s) => {
      const day = toUtcDay(s.timestamp);
      return day >= a && day <= b;
    });

  return {
    current: { start, end, sessions: within(start, end) },
    previous: { start: previousStart, end: previousEnd, sessions: within(previousStart, previousEnd) },
  };
}

export function summarizeUsage(sessions: SessionSummary[]): UsageSummary {
  return {
    costUsd: sessions.reduce((sum, s) => sum + s.totalCostUsd, 0),
    tokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
    sessions: sessions.length,
    projects: new Set(sessions.map((s) => s.project)).size,
  };
}

/** Period-over-period change. `null` previous means "no comparison window". */
export function usageDelta(current: number, previous: number | null): UsageDelta | null {
  if (previous === null) return null;
  if (previous === 0) return current === 0 ? { ratio: 0, kind: "flat" } : { ratio: null, kind: "new" };
  const ratio = current / previous - 1;
  if (Math.abs(ratio) < 0.005) return { ratio, kind: "flat" };
  return { ratio, kind: ratio > 0 ? "up" : "down" };
}

export function aggregateDailyCost(window: UsageWindow): DailyCost[] {
  const byDay = new Map<string, { costUsd: number; tokens: number; sessions: number; projects: Map<string, number> }>();
  for (const date of dayRange(window.start, window.end)) {
    byDay.set(date, { costUsd: 0, tokens: 0, sessions: 0, projects: new Map() });
  }
  for (const s of window.sessions) {
    const day = byDay.get(toUtcDay(s.timestamp));
    if (!day) continue;
    day.costUsd += s.totalCostUsd;
    day.tokens += s.totalTokens;
    day.sessions += 1;
    day.projects.set(s.project, (day.projects.get(s.project) ?? 0) + s.totalCostUsd);
  }
  return Array.from(byDay.entries()).map(([date, day]) => ({
    date,
    costUsd: day.costUsd,
    tokens: day.tokens,
    sessions: day.sessions,
    projects: Array.from(day.projects.entries())
      .map(([project, costUsd]) => ({ project, costUsd }))
      .sort((a, b) => b.costUsd - a.costUsd || a.project.localeCompare(b.project)),
  }));
}

function finishRanks(map: Map<string, Omit<UsageRank, "share">>): UsageRank[] {
  const total = Array.from(map.values()).reduce((sum, r) => sum + r.costUsd, 0);
  return Array.from(map.values())
    .map((r) => ({ ...r, share: total === 0 ? 0 : r.costUsd / total }))
    .sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));
}

export function rankProjectsByCost(sessions: SessionSummary[]): UsageRank[] {
  const map = new Map<string, Omit<UsageRank, "share">>();
  for (const s of sessions) {
    const row = map.get(s.project) ?? { name: s.project, costUsd: 0, tokens: 0, sessions: 0 };
    row.costUsd += s.totalCostUsd;
    row.tokens += s.totalTokens;
    row.sessions += 1;
    map.set(s.project, row);
  }
  return finishRanks(map);
}

export function rankModelsByCost(sessions: SessionSummary[]): UsageRank[] {
  const map = new Map<string, Omit<UsageRank, "share">>();
  for (const s of sessions) {
    for (const m of s.modelBreakdown) {
      const row = map.get(m.model) ?? { name: m.model, costUsd: 0, tokens: 0, sessions: 0 };
      row.costUsd += m.costUsd;
      row.tokens += m.tokens;
      row.sessions += 1;
      map.set(m.model, row);
    }
  }
  return finishRanks(map);
}

export const localClock: LocalClock = (timestamp) => {
  const date = new Date(timestamp);
  return { weekday: date.getDay(), hour: date.getHours() };
};

/** 7 rows (Monday first) × 24 hours. */
export function aggregateWeekdayHourCost(
  sessions: SessionSummary[],
  clock: LocalClock = localClock,
): WeekdayHourCell[][] {
  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, (): WeekdayHourCell => ({ costUsd: 0, sessions: 0 })),
  );
  for (const s of sessions) {
    const { weekday, hour } = clock(s.timestamp);
    const cell = grid[(weekday + 6) % 7][hour];
    cell.costUsd += s.totalCostUsd;
    cell.sessions += 1;
  }
  return grid;
}

/**
 * Rank-based level assignment for sequential colour: level 0 for zero,
 * otherwise 1..levels by percentile among the non-zero values. A single
 * outlier therefore does not push everything else into the lowest band.
 */
export function rankLevels(values: number[], levels = 5): (value: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  return (value) => {
    if (value <= 0 || sorted.length === 0) return 0;
    // Upper rank: ties share the level of their last occurrence, so equal
    // maxima all read as the top band instead of the bottom one.
    let index = sorted.findIndex((v) => v > value) - 1;
    if (index < -1) index = sorted.length - 1;
    const percentile = Math.max(0, index) / Math.max(1, sorted.length - 1);
    return Math.min(levels, Math.max(1, Math.ceil(percentile * levels)));
  };
}

function aggregateNamedCounts(
  sessions: SessionSummary[],
  select: (session: SessionSummary) => NamedCount[],
  limit: number,
): NamedCount[] {
  if (limit <= 0) return [];
  const totals = new Map<string, number>();
  for (const s of sessions) {
    for (const item of select(s)) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  }
  return Array.from(totals.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function aggregateToolCounts(sessions: SessionSummary[], limit = 8): NamedCount[] {
  return aggregateNamedCounts(sessions, (s) => s.toolCounts, limit);
}

export function aggregateSkillCounts(sessions: SessionSummary[], limit = 8): NamedCount[] {
  return aggregateNamedCounts(sessions, (s) => s.skillCounts, limit);
}

import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@/entities/session/sessions";
import {
  aggregateDailyCost,
  aggregateSkillCounts,
  aggregateToolCounts,
  aggregateWeekdayHourCost,
  rankLevels,
  rankModelsByCost,
  rankProjectsByCost,
  splitUsagePeriod,
  summarizeUsage,
  usageDelta,
} from "@/entities/session/usage-aggregation";

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s",
    timestamp: "2026-06-26T10:00:00.000Z",
    project: "alpha",
    title: { kind: "raw", text: "s" },
    totalCostUsd: 1,
    totalTokens: 1000,
    primaryModel: "m",
    modelBreakdown: [{ model: "m", costUsd: 1, tokens: 1000 }],
    toolCounts: [],
    skillCounts: [],
    presence: "external",
    ...overrides,
  };
}

describe("splitUsagePeriod", () => {
  const sessions = [
    session({ id: "old", timestamp: "2026-05-20T10:00:00.000Z", totalCostUsd: 5 }),
    session({ id: "prev", timestamp: "2026-06-18T10:00:00.000Z", totalCostUsd: 2 }),
    session({ id: "edge", timestamp: "2026-06-20T00:30:00.000Z", totalCostUsd: 3 }),
    session({ id: "latest", timestamp: "2026-06-26T23:00:00.000Z", totalCostUsd: 1 }),
  ];

  it("anchors the window on the latest UTC day and includes the boundary day", () => {
    const { current, previous } = splitUsagePeriod(sessions, "7d");

    expect(current.start).toBe("2026-06-20");
    expect(current.end).toBe("2026-06-26");
    expect(current.sessions.map((s) => s.id)).toEqual(["edge", "latest"]);
    expect(previous?.start).toBe("2026-06-13");
    expect(previous?.end).toBe("2026-06-19");
    expect(previous?.sessions.map((s) => s.id)).toEqual(["prev"]);
  });

  it("uses the whole history with no previous window for `all`", () => {
    const { current, previous } = splitUsagePeriod(sessions, "all");

    expect(current.start).toBe("2026-05-20");
    expect(current.sessions).toHaveLength(4);
    expect(previous).toBeNull();
  });

  it("returns an empty window for no sessions", () => {
    const { current, previous } = splitUsagePeriod([], "30d");

    expect(current.sessions).toEqual([]);
    expect(previous?.sessions).toEqual([]);
  });
});

describe("summarizeUsage", () => {
  it("totals cost, tokens, sessions and distinct projects", () => {
    expect(
      summarizeUsage([
        session({ totalCostUsd: 1.5, totalTokens: 10 }),
        session({ totalCostUsd: 0.5, totalTokens: 5, project: "beta" }),
        session({ totalCostUsd: 0, totalTokens: 0, project: "beta" }),
      ]),
    ).toEqual({ costUsd: 2, tokens: 15, sessions: 3, projects: 2 });
  });
});

describe("usageDelta", () => {
  it("reports a signed ratio against the previous value", () => {
    expect(usageDelta(150, 100)).toEqual({ ratio: 0.5, kind: "up" });
    expect(usageDelta(50, 100)).toEqual({ ratio: -0.5, kind: "down" });
    expect(usageDelta(100.1, 100)).toEqual({ ratio: expect.closeTo(0.001, 5), kind: "flat" });
  });

  it("distinguishes 'no previous data' from 'no change'", () => {
    expect(usageDelta(10, 0)).toEqual({ ratio: null, kind: "new" });
    expect(usageDelta(0, 0)).toEqual({ ratio: 0, kind: "flat" });
    expect(usageDelta(10, null)).toBeNull();
  });
});

describe("aggregateDailyCost", () => {
  it("fills every day of the window and splits cost by project", () => {
    const days = aggregateDailyCost({
      start: "2026-06-25",
      end: "2026-06-27",
      sessions: [
        session({ timestamp: "2026-06-25T01:00:00.000Z", totalCostUsd: 1, project: "alpha" }),
        session({ timestamp: "2026-06-25T02:00:00.000Z", totalCostUsd: 3, project: "beta" }),
        session({ timestamp: "2026-06-27T02:00:00.000Z", totalCostUsd: 0.25, project: "alpha", totalTokens: 7 }),
        session({ timestamp: "2026-06-30T02:00:00.000Z", totalCostUsd: 99 }),
      ],
    });

    expect(days.map((d) => d.date)).toEqual(["2026-06-25", "2026-06-26", "2026-06-27"]);
    expect(days[0]).toMatchObject({
      costUsd: 4,
      sessions: 2,
      projects: [
        { project: "beta", costUsd: 3 },
        { project: "alpha", costUsd: 1 },
      ],
    });
    expect(days[1]).toMatchObject({ costUsd: 0, tokens: 0, sessions: 0, projects: [] });
    expect(days[2]).toMatchObject({ costUsd: 0.25, tokens: 7, sessions: 1 });
  });
});

describe("rankProjectsByCost / rankModelsByCost", () => {
  it("ranks projects by cost with share of total", () => {
    const ranks = rankProjectsByCost([
      session({ project: "alpha", totalCostUsd: 3, totalTokens: 30 }),
      session({ project: "beta", totalCostUsd: 1, totalTokens: 10 }),
      session({ project: "alpha", totalCostUsd: 1, totalTokens: 10 }),
    ]);

    expect(ranks).toEqual([
      { name: "alpha", costUsd: 4, tokens: 40, sessions: 2, share: 0.8 },
      { name: "beta", costUsd: 1, tokens: 10, sessions: 1, share: 0.2 },
    ]);
  });

  it("ranks models from the per-session breakdown, not the primary model", () => {
    const ranks = rankModelsByCost([
      session({
        modelBreakdown: [
          { model: "big", costUsd: 3, tokens: 300 },
          { model: "small", costUsd: 1, tokens: 700 },
        ],
      }),
      session({ modelBreakdown: [{ model: "small", costUsd: 1, tokens: 100 }] }),
    ]);

    expect(ranks).toEqual([
      { name: "big", costUsd: 3, tokens: 300, sessions: 1, share: 0.6 },
      { name: "small", costUsd: 2, tokens: 800, sessions: 2, share: 0.4 },
    ]);
  });

  it("returns zero shares when total cost is zero", () => {
    expect(rankProjectsByCost([session({ totalCostUsd: 0 })])[0].share).toBe(0);
  });
});

describe("aggregateWeekdayHourCost", () => {
  it("buckets by weekday (Monday first) and hour using the supplied clock", () => {
    const grid = aggregateWeekdayHourCost(
      [
        // 2026-06-26 is a Friday.
        session({ timestamp: "2026-06-26T09:10:00.000Z", totalCostUsd: 1 }),
        session({ timestamp: "2026-06-26T09:50:00.000Z", totalCostUsd: 2 }),
        // 2026-06-28 is a Sunday.
        session({ timestamp: "2026-06-28T23:59:00.000Z", totalCostUsd: 4 }),
      ],
      (timestamp) => {
        const date = new Date(timestamp);
        return { weekday: date.getUTCDay(), hour: date.getUTCHours() };
      },
    );

    expect(grid).toHaveLength(7);
    expect(grid.every((row) => row.length === 24)).toBe(true);
    expect(grid[4][9]).toEqual({ costUsd: 3, sessions: 2 });
    expect(grid[6][23]).toEqual({ costUsd: 4, sessions: 1 });
    expect(grid[0][0]).toEqual({ costUsd: 0, sessions: 0 });
  });
});

describe("rankLevels", () => {
  it("assigns levels by rank so one outlier does not flatten the rest", () => {
    const level = rankLevels([1, 2, 3, 4, 1000], 5);

    expect(level(0)).toBe(0);
    expect(level(1)).toBe(1);
    expect(level(4)).toBe(4);
    expect(level(1000)).toBe(5);
  });

  it("gives tied maxima the top level", () => {
    const level = rankLevels([3, 3, 1], 5);

    expect(level(3)).toBe(5);
    expect(level(1)).toBe(1);
  });

  it("handles an all-zero input", () => {
    expect(rankLevels([0, 0], 5)(0)).toBe(0);
  });
});

describe("aggregateToolCounts / aggregateSkillCounts", () => {
  it("sums counts across sessions and returns the top results", () => {
    const sessions = [
      session({ toolCounts: [{ name: "Read", count: 3 }, { name: "Edit", count: 1 }], skillCounts: [{ name: "tdd", count: 1 }] }),
      session({ toolCounts: [{ name: "Read", count: 2 }, { name: "Bash", count: 4 }], skillCounts: [] }),
    ];

    expect(aggregateToolCounts(sessions, 2)).toEqual([
      { name: "Read", count: 5 },
      { name: "Bash", count: 4 },
    ]);
    expect(aggregateSkillCounts(sessions)).toEqual([{ name: "tdd", count: 1 }]);
    expect(aggregateSkillCounts(sessions, 0)).toEqual([]);
  });
});

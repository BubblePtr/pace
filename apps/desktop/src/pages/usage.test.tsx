import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@/entities/session/sessions";
import { UsageDashboard } from "@/pages/usage";

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "usage-fixture",
    timestamp: "2026-06-26T10:00:00.000Z",
    project: "/Users/void/code/alpha",
    title: { kind: "raw", text: "usage-fixture" },
    totalCostUsd: 1,
    totalTokens: 1000,
    primaryModel: "gpt-5-codex",
    modelBreakdown: [{ model: "gpt-5-codex", costUsd: 1, tokens: 1000 }],
    toolCounts: [{ name: "Read", count: 2 }],
    skillCounts: [],
    presence: "external",
    ...overrides,
  };
}

const sessions = [
  session({ id: "a", timestamp: "2026-06-26T10:00:00.000Z", totalCostUsd: 3 }),
  session({ id: "b", timestamp: "2026-06-24T10:00:00.000Z", totalCostUsd: 1, project: "/Users/void/code/beta" }),
  session({ id: "c", timestamp: "2026-06-10T10:00:00.000Z", totalCostUsd: 2 }),
  session({ id: "d", timestamp: "2026-05-01T10:00:00.000Z", totalCostUsd: 40 }),
];

const utcClock = (timestamp: string) => {
  const date = new Date(timestamp);
  return { weekday: date.getUTCDay(), hour: date.getUTCHours() };
};

describe("UsageDashboard", () => {
  it("defaults to the last 30 days with four KPI tiles and a period-over-period delta", () => {
    const { container } = render(<UsageDashboard clock={utcClock} sessions={sessions} />);

    expect(screen.getByRole("radio", { name: "30D" })).toBeChecked();
    expect(container.querySelectorAll('[data-slot="kpi"]')).toHaveLength(4);
    const cost = screen.getByText("Cost").closest<HTMLElement>('[data-slot="kpi"]')!;
    expect(within(cost).getByText("$6.00")).toBeInTheDocument();
    // Window is May 28 – Jun 26 ($6); the previous 30 days hold the $40 session.
    expect(within(cost).getByText("-85% vs previous 30 days")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="kpi-footer"] polyline')).toHaveLength(4);
  });

  it("re-scopes every section when the period changes", async () => {
    const user = userEvent.setup();
    render(<UsageDashboard clock={utcClock} sessions={sessions} />);

    await user.click(screen.getByRole("radio", { name: "7D" }));

    const cost = screen.getByText("Cost").closest<HTMLElement>('[data-slot="kpi"]')!;
    expect(within(cost).getByText("$4.00")).toBeInTheDocument();
    const byProject = screen.getByRole("region", { name: "By project" });
    expect(within(byProject).getByText("alpha")).toBeInTheDocument();
    expect(within(byProject).getByText("beta")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(within(cost).getByText("$46.00")).toBeInTheDocument();
    expect(within(cost).queryByText(/vs previous/)).toBeNull();
  });

  it("renders the weekday × hour rhythm grid in the supplied clock", () => {
    render(<UsageDashboard clock={utcClock} sessions={sessions} />);

    const rhythm = screen.getByRole("region", { name: "Rhythm" });
    expect(within(rhythm).getAllByRole("img")).toHaveLength(7 * 24);
    // 2026-06-26 10:00Z is a Friday.
    expect(within(rhythm).getByRole("img", { name: /Fri 10:00.*\$3\.00/ })).toHaveAttribute("data-level", "5");
  });

  it("explains the empty state and how to get data", () => {
    render(<UsageDashboard clock={utcClock} sessions={[]} />);

    expect(screen.getByRole("heading", { name: "No sessions recorded yet" })).toBeInTheDocument();
    expect(screen.getByText(/Start one from Trajectory/)).toBeInTheDocument();
  });

  it("keeps the refresh action wrapped in a tooltip trigger", () => {
    render(<UsageDashboard clock={utcClock} isFetching={false} sessions={sessions} onRefresh={() => {}} />);

    expect(screen.getByTestId("usage-refresh-tooltip-trigger")).toContainElement(
      screen.getByRole("button", { name: "Refresh usage" }),
    );
  });

  it("uses only data tokens for series colour", () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/pages/usage.tsx"), "utf8");

    expect(source).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(source).not.toMatch(/var\(--(success|warning|danger)\)/);
  });
});

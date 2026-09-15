import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  makeLargeSessionDetail,
  largeSessionDetailApproxBytes,
} from "@/entities/session/session-detail.fixtures";
import { SessionDetailView } from "@/pages/session-detail";
import type { SessionDetail, SessionTurn, SubagentRecord } from "@pace/core";

function layoutStripColumns(container: HTMLElement) {
  const columns = [...container.querySelectorAll<HTMLElement>("[data-strip-col]")];
  columns.forEach((column, index) => {
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue({
      x: index * 40,
      y: 0,
      left: index * 40,
      right: (index + 1) * 40,
      top: 0,
      bottom: 24,
      width: 40,
      height: 24,
      toJSON: () => ({}),
    });
  });
}

function agentSubagentRecord(): SubagentRecord {
  return {
    childSessionId: "child-1",
    parentSessionId: "parent-session",
    ownerToolCallId: "call-agent",
    state: "completed",
    source: "tintinweb",
    createdAt: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:01:00.000Z",
  };
}

function agentToolSession(): SessionDetail {
  const turns: SessionTurn[] = [
    {
      kind: "message",
      role: "user",
      timestamp: "2026-09-15T12:00:00.000Z",
      parts: [{ partType: "text", text: "Explore the repo", payload: {} }],
    },
    {
      kind: "message",
      role: "assistant",
      timestamp: "2026-09-15T12:00:10.000Z",
      parts: [
        {
          partType: "toolCall",
          name: "Agent",
          payload: {
            id: "call-agent",
            arguments: { subagent_type: "Explore", prompt: "look around", description: "Explore" },
          },
        },
        {
          partType: "toolResult",
          name: "Agent",
          text: "done",
          payload: { toolCallId: "call-agent" },
        },
      ],
    },
  ];
  return {
    id: "parent-session",
    timestamp: "2026-09-15T12:00:00.000Z",
    project: "fixture-project",
    totalCostUsd: 0,
    totalTokens: 0,
    primaryModel: "gpt-5-codex",
    turnCount: turns.length,
    durationSeconds: 10,
    turns,
  };
}

function emptyModelSegmentSession(): SessionDetail {
  const turns: SessionTurn[] = [
    {
      kind: "message",
      role: "user",
      timestamp: "2026-01-05T15:00:00.000Z",
      parts: [{ partType: "text", text: "Hello", payload: {} }],
    },
    {
      kind: "message",
      role: "assistant",
      timestamp: "2026-01-05T15:00:10.000Z",
      parts: [],
    },
    {
      kind: "message",
      role: "user",
      timestamp: "2026-01-05T15:01:00.000Z",
      parts: [{ partType: "text", text: "Continue", payload: {} }],
    },
    {
      kind: "message",
      role: "assistant",
      timestamp: "2026-01-05T15:01:20.000Z",
      parts: [
        { partType: "thinking", text: "Next step is a tool call.", payload: {} },
        { partType: "toolCall", name: "bash", payload: { id: "c1", arguments: { command: "ls" } } },
      ],
    },
  ];
  return {
    id: "empty-segment-session",
    timestamp: "2026-01-05T15:00:00.000Z",
    project: "fixture-project",
    totalCostUsd: 0,
    totalTokens: 0,
    primaryModel: "gpt-5-codex",
    turnCount: turns.length,
    durationSeconds: 80,
    turns,
  };
}

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();

  return {
    ...actual,
    Link: ({
      children,
      className,
      to,
    }: {
      children: ReactNode;
      className?: string;
      to: string;
    }) => (
      <a className={className} href={to}>
        {children}
      </a>
    ),
    useParams: () => ({ sessionId: "session-a" }),
  };
});

describe("SessionDetailView (Trajectory Cockpit)", () => {
  it("renders the Cockpit panels: Strip, Tally, filter bar, Ledger, Inspector", () => {
    const session = makeLargeSessionDetail(12);
    const { container } = render(<SessionDetailView session={session} sessionId={session.id} />);

    expect(container.querySelector('[data-slot="trajectory-strip"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="trajectory-tally"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="trajectory-filter-bar"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="trajectory-ledger"]')).toBeInTheDocument();
    expect(screen.getByText(/Select a step to inspect it/)).toBeInTheDocument();
    // Tally counts Active Runs, not messages.
    expect(container.querySelector('[data-slot="trajectory-tally"]')?.textContent).toContain("runs");
  });

  it("virtualizes the ledger by Active Run and keeps heavy payloads unmounted", () => {
    const session = makeLargeSessionDetail();
    const { container } = render(<SessionDetailView session={session} sessionId={session.id} />);

    expect(largeSessionDetailApproxBytes).toBeGreaterThan(8 * 1024 * 1024);
    // 128 messages fold into 64 runs; the virtualizer renders a window only.
    expect(container.querySelectorAll("[data-index]").length).toBeLessThan(64);
    // Row previews carry first lines only — the megabyte tool output body
    // never mounts in the ledger.
    expect(screen.queryByText(/1399: large fixture output line/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hidden thinking line 0/)).not.toBeInTheDocument();
  });

  it("pairs toolCall and toolResult into one badge row reading request → result", () => {
    const session = makeLargeSessionDetail(2);
    const { container } = render(<SessionDetailView session={session} sessionId={session.id} />);

    const toolRow = container.querySelector('[data-kind="tool"]');
    expect(toolRow).not.toBeNull();
    expect(toolRow).toHaveAttribute("data-status", "ok");
    expect(within(toolRow as HTMLElement).getByText("read_file")).toBeInTheDocument();
    expect(toolRow?.textContent).toContain("→");
    expect(toolRow?.textContent).toContain("huge output sentinel 0");
  });

  it("opens the Inspector on row selection and mounts the full payload there", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail(2);
    render(<SessionDetailView session={session} sessionId={session.id} />);

    await user.click(screen.getAllByRole("button", { name: /read_file/ })[0]);

    expect(screen.getByText(/Run 1 · Step/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Result" }));
    expect(screen.getByText(/1399: large fixture output line/)).toBeInTheDocument();
  });

  it("shows the Schema tab's honest unavailable state when the current runtime has no definition", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail(2);
    render(<SessionDetailView session={session} sessionId={session.id} />);

    await user.click(screen.getAllByRole("button", { name: /read_file/ })[0]);
    await user.click(screen.getByRole("tab", { name: "Schema" }));

    expect(screen.getByText(/This tool's current definition is unavailable/)).toBeInTheDocument();
  });

  it("shows a resolved Schema when the Gateway returns the current tool definition", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail(2);
    render(
      <SessionDetailView
        session={session}
        sessionId={session.id}
        toolSchemas={{
          read_file: {
            description: "Read a file from disk",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        }}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /read_file/ })[0]);
    await user.click(screen.getByRole("tab", { name: "Schema" }));

    expect(screen.getByText("Read a file from disk")).toBeInTheDocument();
    expect(screen.queryByText(/This tool's current definition is unavailable/)).not.toBeInTheDocument();
  });

  it("filters with the errors chip and reports the visible step count", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail(4);
    const { container } = render(<SessionDetailView session={session} sessionId={session.id} />);

    const tally = () =>
      container.querySelector('[data-slot="trajectory-filter-bar"] .ml-auto')?.textContent;
    const before = tally();

    await user.click(screen.getByRole("button", { name: "errors" }));
    // The large fixture has no error turns in the first 4 messages.
    expect(tally()).not.toEqual(before);
    expect(screen.getByText(/No steps match the current filters/)).toBeInTheDocument();
  });

  it("renders image steps in the Inspector, including data+mimeType payloads", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail(2);
    render(<SessionDetailView session={session} sessionId={session.id} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Fixture thumbnail 0/ }));
    expect(screen.getByRole("img", { name: "Fixture thumbnail 0" })).toBeInTheDocument();
  });

  it("keeps the ledger inside an internal scroll pane with no back navigation", () => {
    const session = makeLargeSessionDetail(12);
    render(<SessionDetailView session={session} sessionId={session.id} />);

    expect(screen.getByTestId("session-detail-view")).toHaveClass(
      "h-full",
      "min-h-0",
      "overflow-hidden",
    );
    expect(screen.getByTestId("session-detail-scroll-body")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
    );
    expect(screen.queryByRole("link", { name: /Trajectory/ })).not.toBeInTheDocument();
  });

  it("renders empty, loading, and error states", () => {
    const { rerender } = render(<SessionDetailView isLoading sessionId="s" />);
    expect(screen.getByText("Loading session...")).toBeInTheDocument();

    rerender(<SessionDetailView isError sessionId="s" />);
    expect(screen.getByText("Could not read this session.")).toBeInTheDocument();

    rerender(
      <SessionDetailView
        session={{ ...makeLargeSessionDetail(0), turns: [] }}
        sessionId="s"
      />,
    );
    expect(screen.getByText("No timeline entries found.")).toBeInTheDocument();
  });

  it("does not steal arrow keys on empty, loading, or error views", () => {
    const { rerender } = render(<SessionDetailView isLoading sessionId="s" />);
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    document.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);

    rerender(<SessionDetailView isError sessionId="s" />);
    const up = new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true });
    document.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(false);

    rerender(
      <SessionDetailView
        session={{ ...makeLargeSessionDetail(0), turns: [] }}
        sessionId="s"
      />,
    );
    const empty = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    document.dispatchEvent(empty);
    expect(empty.defaultPrevented).toBe(false);
  });

  it("focuses a single swimlane block when a strip segment is clicked", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail(4);
    const { container } = render(<SessionDetailView session={session} sessionId={session.id} />);

    await user.click(screen.getAllByRole("option", { name: "Run 1 tools" })[0]);

    expect(screen.getByRole("button", { name: /focus #1 tools/ })).toBeInTheDocument();
    const ledger = container.querySelector('[data-slot="trajectory-ledger"]');
    expect(
      ledger?.querySelectorAll('[data-slot="trajectory-ledger-row"][data-focus-dimmed]').length,
    ).toBeGreaterThan(0);
    expect(
      ledger?.querySelectorAll('[data-slot="trajectory-ledger-row"]:not([data-focus-dimmed])').length,
    ).toBeGreaterThan(0);
  });

  it("keeps the Playhead on the clicked swimlane when the filter hides that block", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail(2);
    render(<SessionDetailView session={session} sessionId={session.id} />);

    await user.click(screen.getByRole("button", { name: "think" }));
    await user.click(screen.getAllByRole("option", { name: "Run 1 tools" })[0]);

    expect(screen.getByRole("button", { name: /focus #1 tools/ })).toBeInTheDocument();
    const inspector = document.querySelector('[data-slot="trajectory-inspector"]');
    expect(inspector).not.toBeNull();
    expect(within(inspector as HTMLElement).getByRole("heading", { name: "read_file" })).toBeInTheDocument();
  });

  it("moves the Playhead onto the brushed range", async () => {
    const session = makeLargeSessionDetail(2);
    const { container } = render(<SessionDetailView session={session} sessionId={session.id} />);
    layoutStripColumns(container);

    const track = screen.getByRole("listbox", { name: "Session activity segments" });
    const tools = screen.getAllByRole("option", { name: "Run 1 tools" })[0];
    const toolsLeft = tools.getBoundingClientRect().left + 8;

    fireEvent.pointerDown(track, { clientX: 8, clientY: 8, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: toolsLeft, clientY: 8, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: toolsLeft, clientY: 8, pointerId: 1 });

    expect(screen.getByRole("heading", { name: /think|read_file/ })).toBeInTheDocument();
    expect(container.querySelector("[data-playhead]")).toBeInTheDocument();
  });

  it("does not dim the whole ledger when the focused segment has no steps", async () => {
    const user = userEvent.setup();
    render(<SessionDetailView session={emptyModelSegmentSession()} sessionId="empty-seg" />);

    await user.click(screen.getByRole("option", { name: "Run 1 model" }));

    expect(screen.getByRole("button", { name: /focus #1 model/ })).toBeInTheDocument();
    const ledger = document.querySelector('[data-slot="trajectory-ledger"]');
    expect(
      ledger?.querySelectorAll('[data-slot="trajectory-ledger-row"]:not([data-focus-dimmed])').length,
    ).toBeGreaterThan(0);

    const down = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    document.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("scrolls a virtualized run into the ledger when the strip jumps to it", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail();
    const { container } = render(<SessionDetailView session={session} sessionId={session.id} />);

    expect(container.querySelector('[data-index="63"]')).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("option", { name: /Run 64 / })[0]);

    await waitFor(() => {
      expect(container.querySelector('[data-index="63"]')).toBeInTheDocument();
    });
  });

  it("opens a child session from an Agent step when the child JSONL is indexed", async () => {
    const user = userEvent.setup();
    const onOpenChildSession = vi.fn();
    render(
      <SessionDetailView
        indexedSessionIds={new Set(["child-1"])}
        session={agentToolSession()}
        sessionId="parent-session"
        subagentsByOwnerToolCallId={new Map([["call-agent", agentSubagentRecord()]])}
        onOpenChildSession={onOpenChildSession}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Agent/ }));
    const action = screen.getByTestId("open-child-session");
    expect(action).toBeEnabled();
    await user.click(action);
    expect(onOpenChildSession).toHaveBeenCalledWith("child-1");
  });

  it("disables Open child session when the child JSONL is not in list_sessions", async () => {
    const user = userEvent.setup();
    const onOpenChildSession = vi.fn();
    render(
      <SessionDetailView
        indexedSessionIds={new Set(["other-session"])}
        session={agentToolSession()}
        sessionId="parent-session"
        subagentsByOwnerToolCallId={new Map([["call-agent", agentSubagentRecord()]])}
        onOpenChildSession={onOpenChildSession}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Agent/ }));
    expect(screen.getByTestId("open-child-session")).toBeDisabled();
    expect(onOpenChildSession).not.toHaveBeenCalled();
  });

  it("does not show Open child session on a non-Agent tool step", async () => {
    const user = userEvent.setup();
    const session = makeLargeSessionDetail(2);
    render(
      <SessionDetailView
        indexedSessionIds={new Set(["child-1"])}
        session={session}
        sessionId={session.id}
        subagentsByOwnerToolCallId={new Map([["call_1", agentSubagentRecord()]])}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /read_file/ })[0]);
    expect(screen.queryByTestId("open-child-session")).not.toBeInTheDocument();
  });
});

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRecord, SubagentSnapshot } from "@pace/core";
import { SessionSubagentsPanel } from "./session-subagents-panel";

const observeSession = vi.fn();
const stop = vi.fn();
const steer = vi.fn();
vi.mock("@/entities/runtime/subagents-client", () => ({
  subagentsClient: {
    observeSession: (...args: unknown[]) => observeSession(...args),
    stop: (...args: unknown[]) => stop(...args),
    steer: (...args: unknown[]) => steer(...args),
  },
}));
const base: SubagentRecord = {
  id: "a",
  rootSessionId: "app",
  rootPiSessionId: "root",
  piSessionId: "child",
  type: "explore",
  description: "Inspect gateway",
  status: "running",
  startedAt: Date.now(),
  toolUses: 1,
  currentTool: "read",
  capabilities: { stop: true, steer: true },
};
const records = [
  base,
  {
    ...base,
    id: "b",
    parentAgentId: "a",
    description: "Check parser",
    type: "review",
    capabilities: { stop: true, steer: false },
  },
];
function props() {
  return {
    piSessionId: "root",
    records,
    available: true,
    loading: false,
    error: null,
    onRefresh: vi.fn(),
    selectedAgentId: null,
    onSelectedAgentChange: vi.fn(),
    onParentNavigate: vi.fn(),
  };
}
function snapshot(record: SubagentRecord): SubagentSnapshot {
  return {
    record,
    toolSchemas: { schemas: {} },
    events: [
      {
        id: "1",
        seq: 1,
        sessionId: "child-app",
        piSessionId: "child",
        type: "message",
        ts: new Date().toISOString(),
        payload: {
          type: "message",
          phase: "end",
          messageId: "m",
          runId: "r",
          turnId: "t",
          role: "assistant",
          origin: "sdk",
          surface: "chat",
          parts: [
            {
              partId: "text",
              partType: "text",
              body: `Result for ${record.id}`,
            },
          ],
        },
      },
    ],
  };
}
beforeEach(() => {
  stop.mockReset().mockResolvedValue(undefined);
  steer.mockReset().mockResolvedValue(undefined);
  observeSession.mockReset().mockImplementation((_root, id, changed) => {
    changed({
      data: snapshot(records.find((record) => record.id === id)!),
      loading: false,
      error: null,
    });
    return { dispose: vi.fn(), refresh: vi.fn() };
  });
});
describe("SessionSubagentsPanel", () => {
  it("opens an owned child and navigates from its detail to its parent", async () => {
    const user = userEvent.setup();
    const input = props();
    const view = render(<SessionSubagentsPanel {...input} />);
    await user.click(screen.getByRole("button", { name: /^review/ }));
    expect(input.onSelectedAgentChange).toHaveBeenCalledWith("b");
    view.rerender(<SessionSubagentsPanel {...input} selectedAgentId="b" />);
    expect(await screen.findByText("Result for b")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Parent agent" }));
    expect(input.onSelectedAgentChange).toHaveBeenCalledWith("a");
    expect(
      screen.queryByRole("textbox", { name: "Message to subagent" }),
    ).not.toBeInTheDocument();
  });
  it("targets stop and steer to the selected child and keeps failed controls actionable", async () => {
    const user = userEvent.setup();
    stop.mockRejectedValueOnce(new Error("Tool has not stopped yet"));
    render(<SessionSubagentsPanel {...props()} selectedAgentId="a" />);
    await screen.findByText("Result for a");
    await user.click(screen.getByRole("button", { name: "Stop subagent" }));
    expect(stop).toHaveBeenCalledWith("root", "a");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tool has not stopped yet",
    );
    expect(screen.getByRole("button", { name: "Stop subagent" })).toBeEnabled();
    await user.type(
      screen.getByRole("textbox", { name: "Message to subagent" }),
      "Focus on events",
    );
    await user.click(screen.getByRole("button", { name: "Send to subagent" }));
    expect(steer).toHaveBeenCalledWith("root", "a", "Focus on events");
  });
  it("disposes only observation when closing a live detail and can reopen historical records", async () => {
    const dispose = vi.fn();
    observeSession.mockImplementation((_root, _id, changed) => {
      changed({
        data: snapshot({
          ...base,
          status: "interrupted",
          capabilities: { stop: false, steer: false },
        }),
        loading: false,
        error: null,
      });
      return { dispose, refresh: vi.fn() };
    });
    const view = render(
      <SessionSubagentsPanel
        {...props()}
        records={[
          {
            ...base,
            status: "interrupted",
            capabilities: { stop: false, steer: false },
          },
        ]}
        selectedAgentId="a"
      />,
    );
    expect(
      await screen.findByText(/ended before this subagent finished/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop subagent" }),
    ).not.toBeInTheDocument();
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });
  it.each(["update", "end"] as const)(
    "shows child tool %s output through the shared Trace inspector",
    async (phase) => {
      const user = userEvent.setup();
      const data = snapshot(base);
      const event = data.events[0];
      data.events.push({
        ...event,
        id: "tool-start",
        seq: 2,
        payload: {
          type: "tool",
          runId: "r",
          turnId: "t",
          toolCallId: "call",
          name: "read",
          phase: "start",
          args: { path: "README.md" },
          origin: "sdk",
          surface: "trace",
        },
      });
      data.events.push({
        ...event,
        id: "tool-result",
        seq: 3,
        payload: {
          type: "tool",
          runId: "r",
          turnId: "t",
          toolCallId: "call",
          name: "read",
          phase,
          result: "Project documentation",
          origin: "sdk",
          surface: "trace",
        },
      });
      observeSession.mockImplementation((_root, _id, changed) => {
        changed({ data, loading: false, error: null });
        return { dispose: vi.fn(), refresh: vi.fn() };
      });
      render(<SessionSubagentsPanel {...props()} selectedAgentId="a" />);
      await user.click(screen.getByRole("button", { name: "Trace" }));
      await user.click(screen.getByRole("button", { name: /^tool\s*read/ }));
      await user.click(screen.getByRole("tab", { name: "Result" }));
      expect(
        screen.getAllByText("Project documentation").length,
      ).toBeGreaterThan(0);
      if (phase === "update") {
        expect(
          screen.getByText("Partial output · tool is still running."),
        ).toBeInTheDocument();
      } else {
        expect(
          screen.queryByText("Partial output · tool is still running."),
        ).not.toBeInTheDocument();
      }
      await user.click(screen.getByRole("tab", { name: "Payload" }));
      expect(screen.getByText(/"path": "README.md"/)).toBeInTheDocument();
    },
  );

  it("does not leak a failed stop response into a different selected child", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    stop.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const input = props();
    const view = render(
      <SessionSubagentsPanel {...input} selectedAgentId="a" />,
    );
    await user.click(screen.getByRole("button", { name: "Stop subagent" }));
    view.rerender(<SessionSubagentsPanel {...input} selectedAgentId="b" />);
    await screen.findByText("Result for b");
    await act(async () => {
      reject(new Error("Previous child stop failed"));
    });
    expect(
      screen.queryByText("Previous child stop failed"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop subagent" })).toBeEnabled();
  });
});

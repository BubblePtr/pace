import { describe, expect, it } from "vitest";
import type { PiSessionState } from "@/entities/runtime/pi-runtime-bridge";
import {
  applySessionProjectionEvent,
  canArchiveSessionProjection,
  createSessionProjection,
  getSessionProjectionListItems,
  type SessionProjection,
} from "@/entities/session/session-projection";

function projection(overrides: Partial<SessionProjection>): SessionProjection {
  return {
    ...createSessionProjection({
      id: overrides.id ?? "session",
      projectId: overrides.projectId ?? "pig",
      initialPrompt: overrides.initialPrompt ?? "Investigate Pig session state",
      createdAt: overrides.createdAt ?? "2026-06-26T08:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("Session Projection state", () => {
  it("shows interrupted cold history as settled and does not let a late snapshot replace newer live events", () => {
    const base = projection({ piSessionId: "pi", status: "completed" });
    const start = { seq: 1, timestamp: "2026-09-14T00:00:00.000Z", event: {
      type: "run" as const, phase: "start" as const, runId: "run-1", piSessionId: "pi",
      trigger: "prompt" as const, origin: "sdk" as const, surface: "hidden" as const,
    } };
    const state: PiSessionState = { piSessionId: "pi", runtimeId: "runtime", projectId: "p", cwd: "/repo",
      executionState: "cold", status: "failed", events: [], replay: [{ kind: "agent", entry: start }], updatedAt: start.timestamp };
    const history = applySessionProjectionEvent(base, { type: "runtime-state-resynced", state });
    expect(history.status).toBe("failed");

    const live = applySessionProjectionEvent(history, { type: "agent-event-received", entry: {
      ...start, seq: 3, event: { ...start.event, runId: "run-2" },
    } });
    const restarted = applySessionProjectionEvent(live, { type: "runtime-state-resynced", state });
    expect(restarted.status).toBe("failed");
    expect(restarted.runtimeModel.runs.has("run-2")).toBe(false);
    const refreshed = applySessionProjectionEvent(live, {
      type: "runtime-state-resynced", state: { ...state, executionState: "ready" },
    });
    expect(refreshed.runtimeModel.lastSeq).toBe(3);
    expect(refreshed.runtimeModel.runs.has("run-2")).toBe(true);
    expect(refreshed.status).toBe("running");
    const finished = applySessionProjectionEvent(refreshed, { type: "agent-event-received", entry: {
      ...start, seq: 4, event: { ...start.event, runId: "run-2", phase: "end", outcome: "completed" },
    } });
    expect(finished.status).toBe("completed");
  });

  it("keeps concurrent sessions in last user message order until the user sends again", () => {
    function send(session: SessionProjection, role: "user" | "assistant", timestamp: string) {
      return applySessionProjectionEvent(session, {
        type: "runtime-event-received",
        stage: "accepted",
        ...(role === "user" ? { submittedAt: timestamp } : {}),
        event: {
          id: `${session.id}-${timestamp}`,
          piSessionId: `pi-${session.id}`,
          kind: "message",
          role,
          body: role === "user" ? "Continue the task" : "Still working",
          timestamp,
        },
      });
    }

    let older = send(projection({ id: "older" }), "user", "2026-06-26T08:01:00.000Z");
    const newer = send(projection({ id: "newer" }), "user", "2026-06-26T08:02:00.000Z");
    const order = (sessions: SessionProjection[]) =>
      getSessionProjectionListItems(sessions).map((item) => item.id);

    expect(order([older, newer])).toEqual(["newer", "older"]);
    older = send(older, "assistant", "2026-06-26T08:03:00.000Z");
    expect(order([older, newer])).toEqual(["newer", "older"]);

    const finished = applySessionProjectionEvent(newer, {
      type: "run-completed",
      event: {
        id: "newer-result",
        piSessionId: "pi-newer",
        kind: "message",
        role: "assistant",
        body: "Done",
        timestamp: "2026-06-26T08:04:00.000Z",
      },
    });
    expect(order([older, finished])).toEqual(["newer", "older"]);
    expect(order([older, { ...finished, unreadResult: false }])).toEqual(["newer", "older"]);

    older = send(older, "user", "2026-06-26T08:05:00.000Z");
    expect(order([finished, older])).toEqual(["older", "newer"]);
  });

  it("shows the custom title in list items and falls back to the initial prompt", () => {
    expect(
      getSessionProjectionListItems([
        projection({
          id: "renamed",
          initialPrompt: "Investigate Pig session state",
          title: "Sidebar actions",
        }),
        projection({ id: "unnamed", initialPrompt: "Investigate Pig session state" }),
      ]).map((item) => item.title),
    ).toEqual(["Sidebar actions", "Investigate Pig session state"]);
  });

  it("tracks creation stages, runtime binding, and the first runtime event", () => {
    const created = createSessionProjection({
      id: "session-1",
      projectId: "pig",
      initialPrompt: "Create a resumable live session",
      createdAt: "2026-06-26T08:00:00.000Z",
    });
    const withCheckout = applySessionProjectionEvent(created, {
      type: "checkout-selected",
      stage: "preparing checkout",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
      occurredAt: "2026-06-26T08:00:01.000Z",
    });
    const withRuntime = applySessionProjectionEvent(withCheckout, {
      type: "runtime-bound",
      stage: "starting runtime",
      runtimeId: "runtime-1",
      piSessionId: "pi-session-1",
      occurredAt: "2026-06-26T08:00:02.000Z",
    });
    const running = applySessionProjectionEvent(withRuntime, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-1",
        piSessionId: "pi-session-1",
        kind: "message",
        role: "user",
        body: "Create a resumable live session",
        timestamp: "2026-06-26T08:00:03.000Z",
      },
    });

    expect(created).toMatchObject({
      projectId: "pig",
      status: "creating",
      creationStage: "preparing checkout",
      runtimeEvents: [],
      stale: false,
    });
    expect(withCheckout).toMatchObject({
      status: "creating",
      creationStage: "preparing checkout",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    expect(withRuntime).toMatchObject({
      status: "creating",
      creationStage: "starting runtime",
      runtimeId: "runtime-1",
      piSessionId: "pi-session-1",
    });
    expect(running).toMatchObject({
      status: "running",
      creationStage: "accepted",
      runtimeEvents: [
        expect.objectContaining({
          id: "runtime-event-1",
          body: "Create a resumable live session",
        }),
      ],
      updatedAt: "2026-06-26T08:00:03.000Z",
    });
  });

  it("records completion and failure as unread result events that clear after latest message render", () => {
    const base = projection({
      id: "session-result",
      status: "running",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const completed = applySessionProjectionEvent(base, {
      type: "run-completed",
      event: {
        id: "event-completed",
        piSessionId: "pi-session-result",
        kind: "message",
        role: "assistant",
        body: "Run completed. The workspace shell is ready.",
        timestamp: "2026-06-26T08:08:00.000Z",
      },
    });
    const read = applySessionProjectionEvent(completed, {
      type: "latest-message-rendered",
      occurredAt: "2026-06-26T08:09:00.000Z",
    });
    const failed = applySessionProjectionEvent(base, {
      type: "run-failed",
      event: {
        id: "event-failed",
        piSessionId: "pi-session-result",
        kind: "message",
        role: "assistant",
        body: "Run failed. Pi lost the runtime stream.",
        timestamp: "2026-06-26T08:10:00.000Z",
      },
    });

    expect(completed).toMatchObject({
      status: "completed",
      unreadResult: true,
      runtimeEvents: [
        expect.objectContaining({
          id: "event-completed",
          body: "Run completed. The workspace shell is ready.",
        }),
      ],
      updatedAt: "2026-06-26T08:08:00.000Z",
    });
    expect(read).toMatchObject({
      unreadResult: false,
      updatedAt: "2026-06-26T08:08:00.000Z",
    });
    expect(failed).toMatchObject({
      status: "failed",
      unreadResult: true,
      runtimeEvents: [
        expect.objectContaining({
          id: "event-failed",
          body: "Run failed. Pi lost the runtime stream.",
        }),
      ],
      updatedAt: "2026-06-26T08:10:00.000Z",
    });
  });

  it("keeps queued follow-up messages pending until the runtime starts processing them", () => {
    const base = projection({
      id: "active-run",
      status: "running",
      piSessionId: "pi-session-active",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const queued = applySessionProjectionEvent(base, {
      type: "queued-message-added",
      queuedMessage: {
        id: "queued-1",
        piSessionId: "pi-session-active",
        body: "After this, update the usage tests.",
        status: "pending",
        createdAt: "2026-06-26T08:01:00.000Z",
      },
    });
    const withdrawn = applySessionProjectionEvent(queued, {
      type: "queued-message-withdrawn",
      queuedMessageId: "queued-1",
      occurredAt: "2026-06-26T08:01:30.000Z",
    });
    const queuedAgain = applySessionProjectionEvent(withdrawn, {
      type: "queued-message-added",
      queuedMessage: {
        id: "queued-2",
        piSessionId: "pi-session-active",
        body: "Then refresh the browser screenshot.",
        status: "pending",
        createdAt: "2026-06-26T08:02:00.000Z",
      },
    });
    const processing = applySessionProjectionEvent(queuedAgain, {
      type: "queued-message-processing-started",
      queuedMessageId: "queued-2",
      event: {
        id: "queued-2-runtime-event",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Then refresh the browser screenshot.",
        timestamp: "2026-06-26T08:03:00.000Z",
      },
    });

    expect(queued.queuedMessages).toEqual([
      expect.objectContaining({
        id: "queued-1",
        body: "After this, update the usage tests.",
        status: "pending",
      }),
    ]);
    expect(queued.runtimeEvents).toEqual([]);
    expect(getSessionProjectionListItems([queued])[0]?.updatedAt).toBe(
      "2026-06-26T08:01:00.000Z",
    );
    expect(getSessionProjectionListItems([withdrawn])[0]?.updatedAt).toBe(
      "2026-06-26T08:01:00.000Z",
    );
    expect(withdrawn.queuedMessages).toEqual([
      expect.objectContaining({
        id: "queued-1",
        status: "withdrawn",
      }),
    ]);
    expect(processing.queuedMessages).toEqual([
      expect.objectContaining({ id: "queued-1", status: "withdrawn" }),
      expect.objectContaining({
        id: "queued-2",
        status: "processing",
        processingStartedAt: "2026-06-26T08:03:00.000Z",
      }),
    ]);
    expect(processing.runtimeEvents).toEqual([
      expect.objectContaining({
        id: "queued-2-runtime-event",
        role: "user",
        body: "Then refresh the browser screenshot.",
      }),
    ]);
    expect(processing.updatedAt).toBe("2026-06-26T08:03:00.000Z");
    expect(getSessionProjectionListItems([processing])[0]?.updatedAt).toBe(
      "2026-06-26T08:02:00.000Z",
    );
  });

  it("promotes a matching queued follow-up when the runtime emits the user message", () => {
    const base = projection({
      id: "active-run",
      status: "running",
      piSessionId: "pi-session-active",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const queued = applySessionProjectionEvent(base, {
      type: "queued-message-added",
      queuedMessage: {
        id: "queued-1",
        piSessionId: "pi-session-active",
        body: "Then refresh the browser screenshot.",
        status: "pending",
        createdAt: "2026-06-26T08:02:00.000Z",
      },
    });
    const processing = applySessionProjectionEvent(queued, {
      type: "runtime-event-received",
      event: {
        id: "runtime-event-follow-up",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Then refresh the browser screenshot.",
        timestamp: "2026-06-26T08:03:00.000Z",
      },
    });

    expect(processing.queuedMessages).toEqual([
      expect.objectContaining({
        id: "queued-1",
        status: "processing",
        processingStartedAt: "2026-06-26T08:03:00.000Z",
      }),
    ]);
    expect(processing.runtimeEvents).toEqual([
      expect.objectContaining({
        id: "runtime-event-follow-up",
        role: "user",
        body: "Then refresh the browser screenshot.",
      }),
    ]);
  });

  it("updates one Live Chat assistant message for streaming events with the same message identity", () => {
    const base = projection({
      id: "streaming-run",
      status: "running",
      piSessionId: "pi-session-active",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const first = applySessionProjectionEvent(base, {
      type: "runtime-event-received",
      event: {
        id: "runtime-event-assistant-1",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "assistant",
        body: "我们",
        timestamp: "2026-06-26T08:00:01.000Z",
        messageId: "pi-sdk:pi-session-active:assistant:0",
      },
    });
    const second = applySessionProjectionEvent(first, {
      type: "runtime-event-received",
      event: {
        id: "runtime-event-assistant-2",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "assistant",
        body: "我们被",
        timestamp: "2026-06-26T08:00:02.000Z",
        messageId: "pi-sdk:pi-session-active:assistant:0",
      },
    });
    const latest = applySessionProjectionEvent(second, {
      type: "runtime-event-received",
      event: {
        id: "runtime-event-assistant-3",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "assistant",
        body: "我们被要求",
        timestamp: "2026-06-26T08:00:03.000Z",
        messageId: "pi-sdk:pi-session-active:assistant:0",
      },
    });

    expect(latest.runtimeEvents).toEqual([
      expect.objectContaining({
        role: "assistant",
        body: "我们被要求",
        messageId: "pi-sdk:pi-session-active:assistant:0",
      }),
    ]);
    expect(latest.updatedAt).toBe("2026-06-26T08:00:03.000Z");
  });

  it("updates one trace item for streaming events with the same trace identity", () => {
    const base = projection({
      id: "active-run",
      status: "running",
      piSessionId: "pi-session-active",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const thinkingStarted = applySessionProjectionEvent(base, {
      type: "runtime-event-received",
      event: {
        id: "runtime-thinking-1",
        piSessionId: "pi-session-active",
        kind: "thinking",
        role: "assistant",
        body: "先看",
        timestamp: "2026-06-26T08:00:01.000Z",
        messageId: "pi-sdk:pi-session-active:assistant:0",
      },
    });
    const thinkingUpdated = applySessionProjectionEvent(thinkingStarted, {
      type: "runtime-event-received",
      event: {
        id: "runtime-thinking-2",
        piSessionId: "pi-session-active",
        kind: "thinking",
        role: "assistant",
        body: "先看项目结构",
        timestamp: "2026-06-26T08:00:02.000Z",
        messageId: "pi-sdk:pi-session-active:assistant:0",
      },
    });
    const toolStarted = applySessionProjectionEvent(thinkingUpdated, {
      type: "runtime-event-received",
      event: {
        id: "runtime-tool-1",
        piSessionId: "pi-session-active",
        kind: "tool-call",
        title: "read",
        body: "{\"path\":\"AGENTS.md\"}",
        timestamp: "2026-06-26T08:00:03.000Z",
        toolCallId: "tool-call-1",
      },
    });
    const toolUpdated = applySessionProjectionEvent(toolStarted, {
      type: "runtime-event-received",
      event: {
        id: "runtime-tool-2",
        piSessionId: "pi-session-active",
        kind: "tool-call",
        title: "read",
        body: "{\"path\":\"CONTEXT.md\"}",
        timestamp: "2026-06-26T08:00:04.000Z",
        toolCallId: "tool-call-1",
      },
    });

    expect(toolUpdated.runtimeEvents).toEqual([
      expect.objectContaining({
        id: "runtime-thinking-2",
        kind: "thinking",
        body: "先看项目结构",
        messageId: "pi-sdk:pi-session-active:assistant:0",
      }),
      expect.objectContaining({
        id: "runtime-tool-2",
        kind: "tool-call",
        body: "{\"path\":\"CONTEXT.md\"}",
        toolCallId: "tool-call-1",
      }),
    ]);
  });

  it("records steer control events in the active Live Chat stream", () => {
    const base = projection({
      id: "active-run",
      status: "running",
      piSessionId: "pi-session-active",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const steered = applySessionProjectionEvent(base, {
      type: "steer-submitted",
      event: {
        id: "steer-event-1",
        piSessionId: "pi-session-active",
        kind: "control",
        role: "user",
        title: "Steer",
        body: "Stay focused on the queue behavior.",
        timestamp: "2026-06-26T08:04:00.000Z",
      },
    });

    expect(steered).toMatchObject({
      status: "running",
      unreadResult: false,
      updatedAt: "2026-06-26T08:04:00.000Z",
      runtimeEvents: [
        expect.objectContaining({
          kind: "control",
          title: "Steer",
          body: "Stay focused on the queue behavior.",
        }),
      ],
    });
    expect(steered.queuedMessages).toEqual([]);
    expect(getSessionProjectionListItems([steered])[0]?.updatedAt).toBe(
      "2026-06-26T08:04:00.000Z",
    );
  });

  it("records stopped runs as completed and archiveable", () => {
    const base = projection({
      id: "active-run",
      status: "running",
      piSessionId: "pi-session-active",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const stopped = applySessionProjectionEvent(base, {
      type: "run-stopped",
      event: {
        id: "stop-event-1",
        piSessionId: "pi-session-active",
        kind: "status",
        title: "Stopped",
        body: "Pi stopped the active run.",
        timestamp: "2026-06-26T08:05:00.000Z",
      },
    });

    expect(stopped).toMatchObject({
      status: "completed",
      unreadResult: true,
      updatedAt: "2026-06-26T08:05:00.000Z",
      runtimeEvents: [
        expect.objectContaining({
          kind: "status",
          title: "Stopped",
        }),
      ],
    });
    expect(canArchiveSessionProjection(stopped)).toBe(true);
  });

  it("records stop failures without ending the active run", () => {
    const base = projection({
      id: "active-run",
      status: "running",
      piSessionId: "pi-session-active",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const failedStop = applySessionProjectionEvent(base, {
      type: "run-stop-failed",
      event: {
        id: "stop-failed-event-1",
        piSessionId: "pi-session-active",
        kind: "error",
        title: "Stop failed",
        body: "Pi rejected the stop request.",
        timestamp: "2026-06-26T08:05:00.000Z",
      },
    });

    expect(failedStop).toMatchObject({
      status: "running",
      unreadResult: false,
      updatedAt: "2026-06-26T08:05:00.000Z",
      runtimeEvents: [
        expect.objectContaining({
          kind: "error",
          title: "Stop failed",
        }),
      ],
    });
    expect(canArchiveSessionProjection(failedStop)).toBe(false);
  });

  it("prevents active archive and keeps archived sessions available to history queries", () => {
    const active = projection({
      id: "active-run",
      status: "running",
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    const completed = projection({
      id: "completed-run",
      status: "completed",
      updatedAt: "2026-06-26T08:01:00.000Z",
    });

    expect(canArchiveSessionProjection(active)).toBe(false);
    expect(() =>
      applySessionProjectionEvent(active, {
        type: "session-archived",
        occurredAt: "2026-06-26T08:02:00.000Z",
      }),
    ).toThrow("Cannot archive an active Session.");

    expect(canArchiveSessionProjection(completed)).toBe(true);

    const archived = applySessionProjectionEvent(completed, {
      type: "session-archived",
      occurredAt: "2026-06-26T08:02:00.000Z",
    });

    expect(archived).toMatchObject({
      status: "completed",
      archivedAt: "2026-06-26T08:02:00.000Z",
    });
    expect(getSessionProjectionListItems([archived])).toEqual([]);
    expect(getSessionProjectionListItems([archived], { includeArchived: true })).toEqual([
      expect.objectContaining({
        id: "completed-run",
        archived: true,
      }),
    ]);
  });

  it("marks stale projection state and resyncs from Pi Session State as runtime truth", () => {
    const projection = createSessionProjection({
      id: "session-1",
      projectId: "pig",
      initialPrompt: "Create a resumable live session",
      createdAt: "2026-06-26T08:00:00.000Z",
    });
    const stale = applySessionProjectionEvent(projection, {
      type: "projection-marked-stale",
      reason: "runtime event stream disconnected",
      occurredAt: "2026-06-26T08:00:10.000Z",
    });
    const resynced = applySessionProjectionEvent(stale, {
      type: "runtime-state-resynced",
      state: {
        piSessionId: "pi-session-1",
        runtimeId: "runtime-1",
        projectId: "pig",
        cwd: "/Users/void/code/opensource/Pig",
        status: "completed",
        updatedAt: "2026-06-26T08:00:12.000Z",
        events: [
          {
            id: "runtime-event-1",
            piSessionId: "pi-session-1",
            kind: "message",
            role: "user",
            body: "Create a resumable live session",
            timestamp: "2026-06-26T08:00:03.000Z",
          },
          {
            id: "runtime-event-2",
            piSessionId: "pi-session-1",
            kind: "message",
            role: "assistant",
            body: "Live session is ready.",
            timestamp: "2026-06-26T08:00:12.000Z",
          },
        ],
      },
    });

    expect(stale).toMatchObject({
      stale: true,
      staleReason: "runtime event stream disconnected",
      // Stale is not chat activity — list time stays at last real activity.
      updatedAt: "2026-06-26T08:00:00.000Z",
    });
    expect(resynced).toMatchObject({
      status: "completed",
      stale: false,
      staleReason: null,
      runtimeId: "runtime-1",
      piSessionId: "pi-session-1",
      runtimeEvents: [
        expect.objectContaining({ id: "runtime-event-1" }),
        expect.objectContaining({ id: "runtime-event-2", body: "Live session is ready." }),
      ],
      // Last message timestamp, not resume wall-clock state.updatedAt alone.
      updatedAt: "2026-06-26T08:00:12.000Z",
    });
  });

  it("does not treat resume wall-clock as last chat time (DF-010)", () => {
    const projection = createSessionProjection({
      id: "session-1",
      projectId: "pig",
      initialPrompt: "Old conversation",
      createdAt: "2026-07-30T05:52:27.000Z",
    });
    const withMessages = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      event: {
        id: "user-1",
        piSessionId: "pi-session-1",
        kind: "message",
        role: "user",
        body: "Old conversation",
        timestamp: "2026-07-30T05:52:27.500Z",
      },
    });
    const withAnswer = applySessionProjectionEvent(withMessages, {
      type: "runtime-event-received",
      event: {
        id: "asst-1",
        piSessionId: "pi-session-1",
        kind: "message",
        role: "assistant",
        body: "Answer from yesterday",
        timestamp: "2026-07-30T05:53:00.000Z",
      },
    });
    const openedToday = applySessionProjectionEvent(withAnswer, {
      type: "runtime-state-resynced",
      state: {
        piSessionId: "pi-session-1",
        runtimeId: "runtime-1",
        projectId: "pig",
        cwd: "/Users/void/code/opensource/Pig",
        status: "completed",
        // Driver stamps "now" on every resume — must not become list time.
        updatedAt: "2026-08-01T11:19:00.000Z",
        events: [
          {
            id: "user-1",
            piSessionId: "pi-session-1",
            kind: "message",
            role: "user",
            body: "Old conversation",
            timestamp: "2026-07-30T05:52:27.500Z",
          },
          {
            id: "asst-1",
            piSessionId: "pi-session-1",
            kind: "message",
            role: "assistant",
            body: "Answer from yesterday",
            timestamp: "2026-07-30T05:53:00.000Z",
          },
        ],
      },
    });

    expect(openedToday.updatedAt).toBe("2026-07-30T05:53:00.000Z");
    expect(getSessionProjectionListItems([openedToday])[0]?.updatedAt).toBe(
      "2026-07-30T05:52:27.500Z",
    );
  });

  it("rebuilds the runtime model statically from the snapshot replay sequence", () => {
    const runId = "pi-session-1:run-1";
    const turnId = `${runId}:turn-1`;
    const messageId = `${turnId}:msg-1`;
    const partId = `${messageId}:part-0`;
    const projection = createSessionProjection({
      id: "session-1",
      projectId: "pig",
      initialPrompt: "Fix the bug",
      createdAt: "2026-07-03T10:00:00.000Z",
    });
    const state: PiSessionState = {
      piSessionId: "pi-session-1",
      runtimeId: "pi-sdk:session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "completed",
      events: [],
      replay: [
        {
          kind: "chat",
          seq: 1,
          event: {
            id: "evt-user",
            piSessionId: "pi-session-1",
            kind: "message",
            role: "user",
            body: "Fix the bug",
            timestamp: "2026-07-03T10:00:01.000Z",
          },
        },
        {
          kind: "agent",
          entry: {
            seq: 2,
            timestamp: "2026-07-03T10:00:02.000Z",
            event: {
              type: "run",
              runId,
              phase: "start",
              trigger: "prompt",
              surface: "hidden",
              origin: "sdk",
            },
          },
        },
        {
          kind: "agent",
          entry: {
            seq: 3,
            timestamp: "2026-07-03T10:00:03.000Z",
            event: {
              type: "message",
              runId,
              turnId,
              messageId,
              role: "assistant",
              phase: "start",
              surface: "chat",
              origin: "sdk",
            },
          },
        },
        {
          kind: "agent",
          entry: {
            seq: 4,
            timestamp: "2026-07-03T10:00:04.000Z",
            event: {
              type: "message_part",
              runId,
              turnId,
              messageId,
              partId,
              partType: "text",
              phase: "end",
              bodyMode: "snapshot",
              body: "Hello.",
              surface: "chat",
              origin: "sdk",
            },
          },
        },
        {
          kind: "agent",
          entry: {
            seq: 5,
            timestamp: "2026-07-03T10:00:05.000Z",
            event: {
              type: "message",
              runId,
              turnId,
              messageId,
              role: "assistant",
              phase: "end",
              parts: [{ partId, partType: "text", body: "Hello." }],
              surface: "chat",
              origin: "sdk",
            },
          },
        },
        {
          kind: "agent",
          entry: {
            seq: 6,
            timestamp: "2026-07-03T10:00:06.000Z",
            event: {
              type: "run",
              runId,
              phase: "end",
              trigger: "prompt",
              outcome: "completed",
              surface: "hidden",
              origin: "sdk",
            },
          },
        },
      ],
      updatedAt: "2026-07-03T10:00:06.000Z",
    };
    const resynced = applySessionProjectionEvent(projection, {
      type: "runtime-state-resynced",
      state,
    });

    // Session Status comes from the rebuilt model (run end owns it), and the
    // replayed timeline is fully static: nothing is left streaming.
    expect(resynced.status).toBe("completed");
    expect(resynced.runtimeModel.runs.get(runId)).toMatchObject({
      trigger: "prompt",
      outcome: "completed",
    });
    expect(resynced.runtimeModel.messages.get(messageId)).toMatchObject({
      role: "assistant",
      phase: "final",
      // Both message boundaries are journalled, so a restart still knows how
      // long the call took — the trace does not degrade to an estimate.
      startedAt: "2026-07-03T10:00:03.000Z",
      updatedAt: "2026-07-03T10:00:05.000Z",
      parts: [expect.objectContaining({ body: "Hello.", done: true })],
    });
    expect(resynced.runtimeModel.messages.get("evt-user")).toMatchObject({
      role: "user",
      phase: "final",
      parts: [expect.objectContaining({ body: "Fix the bug" })],
    });
    // The mirrored user echo keeps its place before the Active Run.
    expect(
      resynced.runtimeModel.order.filter((entry) => entry.kind === "message"),
    ).toEqual([
      expect.objectContaining({ id: "evt-user" }),
      expect.objectContaining({ id: messageId }),
    ]);

    // Replaying the same snapshot again must not duplicate anything.
    const replayedTwice = applySessionProjectionEvent(resynced, {
      type: "runtime-state-resynced",
      state,
    });

    expect(replayedTwice.runtimeModel.order).toEqual(resynced.runtimeModel.order);
    expect(replayedTwice.runtimeModel.messages.size).toBe(
      resynced.runtimeModel.messages.size,
    );
  });

  it("keeps the runtime model untouched when resync state carries no replay sequence", () => {
    const projection = createSessionProjection({
      id: "session-1",
      projectId: "pig",
      initialPrompt: "Fix the bug",
      createdAt: "2026-07-03T10:00:00.000Z",
    });
    const withLiveModel = applySessionProjectionEvent(projection, {
      type: "agent-event-received",
      entry: {
        seq: 1,
        timestamp: "2026-07-03T10:00:01.000Z",
        event: {
          type: "run",
          runId: "pi-session-1:run-1",
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        },
      },
    });
    const resynced = applySessionProjectionEvent(withLiveModel, {
      type: "runtime-state-resynced",
      state: {
        piSessionId: "pi-session-1",
        runtimeId: "runtime-1",
        projectId: "pig",
        cwd: "/Users/void/code/opensource/Pig",
        status: "running",
        events: [],
        updatedAt: "2026-07-03T10:00:02.000Z",
      },
    });

    expect(resynced.runtimeModel).toBe(withLiveModel.runtimeModel);
  });

  it("collapses streaming assistant updates when resyncing runtime state", () => {
    const projection = createSessionProjection({
      id: "session-1",
      projectId: "pig",
      initialPrompt: "测试一下",
      createdAt: "2026-06-26T08:00:00.000Z",
    });
    const resynced = applySessionProjectionEvent(projection, {
      type: "runtime-state-resynced",
      state: {
        piSessionId: "pi-session-1",
        runtimeId: "runtime-1",
        projectId: "pig",
        cwd: "/Users/void/code/opensource/Pig",
        status: "running",
        events: [
          {
            id: "runtime-event-1",
            piSessionId: "pi-session-1",
            kind: "message",
            role: "assistant",
            body: "我们",
            timestamp: "2026-06-26T08:00:03.000Z",
            messageId: "pi-sdk:pi-session-1:assistant:0",
          },
          {
            id: "runtime-event-2",
            piSessionId: "pi-session-1",
            kind: "message",
            role: "assistant",
            body: "我们被",
            timestamp: "2026-06-26T08:00:04.000Z",
            messageId: "pi-sdk:pi-session-1:assistant:0",
          },
          {
            id: "runtime-event-3",
            piSessionId: "pi-session-1",
            kind: "message",
            role: "assistant",
            body: "我们被要求",
            timestamp: "2026-06-26T08:00:05.000Z",
            messageId: "pi-sdk:pi-session-1:assistant:0",
          },
        ],
        updatedAt: "2026-06-26T08:00:05.000Z",
      },
    });

    expect(resynced.runtimeEvents).toEqual([
      expect.objectContaining({
        role: "assistant",
        body: "我们被要求",
        messageId: "pi-sdk:pi-session-1:assistant:0",
      }),
    ]);
  });

  it("derives status from Active Run events and stops letting legacy status events flip it", () => {
    const runId = "pi-session-1:run-1";
    let projection = createSessionProjection({
      id: "session-1",
      projectId: "project-1",
      initialPrompt: "Ship it",
      createdAt: "2026-07-02T10:00:00.000Z",
    });

    projection = applySessionProjectionEvent(projection, {
      type: "agent-event-received",
      entry: {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        },
      },
    });

    expect(projection.status).toBe("running");
    expect(projection.runtimeModel.runs.get(runId)).toBeDefined();

    // The legacy compat stream still records events, but once run events own
    // the status a legacy "status" kind must not complete the session.
    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      event: {
        id: "legacy-retrying",
        piSessionId: "pi-session-1",
        kind: "status",
        title: "Retrying",
        body: "stream disconnected",
        timestamp: "2026-07-02T10:00:02.000Z",
      },
    });

    expect(projection.status).toBe("running");
    expect(projection.runtimeEvents).toHaveLength(1);

    projection = applySessionProjectionEvent(projection, {
      type: "agent-event-received",
      entry: {
        seq: 2,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "message",
          runId,
          turnId: `${runId}:turn-1`,
          messageId: `${runId}:turn-1:msg-1`,
          role: "assistant",
          phase: "end",
          parts: [
            {
              partId: `${runId}:turn-1:msg-1:part-0`,
              partType: "text",
              body: "Done",
            },
          ],
          surface: "chat",
          origin: "sdk",
        },
      },
    });
    projection = applySessionProjectionEvent(projection, {
      type: "agent-event-received",
      entry: {
        seq: 3,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        },
      },
    });

    expect(projection.status).toBe("completed");
    expect(projection.unreadResult).toBe(true);
    expect(projection.updatedAt).toBe("2026-07-02T10:00:04.000Z");
    expect(
      projection.runtimeModel.messages.get(`${runId}:turn-1:msg-1`),
    ).toMatchObject({
      phase: "final",
      parts: [{ partType: "text", body: "Done" }],
    });
  });

  it("merges usage agent events into the projection summary", () => {
    let projection = createSessionProjection({
      id: "session-1",
      projectId: "project-1",
      initialPrompt: "Ship it",
      createdAt: "2026-07-02T10:00:00.000Z",
    });

    projection = applySessionProjectionEvent(projection, {
      type: "agent-event-received",
      entry: {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "usage",
          runId: "pi-session-1:run-1",
          summary: {
            provider: "openai",
            model: "gpt-5-codex",
            totalTokens: 1280,
            totalCostUsd: 0.012345,
          },
          surface: "hidden",
          origin: "rpc",
        },
      },
    });

    expect(projection.summary).toEqual({
      provider: "openai",
      model: "gpt-5-codex",
      totalTokens: 1280,
      totalCostUsd: 0.012345,
    });
  });

  it("tracks context-window occupancy across turns, compaction, and resume", () => {
    let projection = createSessionProjection({
      id: "session-1",
      projectId: "project-1",
      initialPrompt: "Ship it",
      createdAt: "2026-07-02T10:00:00.000Z",
    });

    expect(projection.contextUsage).toBeNull();

    projection = applySessionProjectionEvent(projection, {
      type: "agent-event-received",
      entry: {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "context_usage",
          runId: "pi-session-1:run-1",
          usage: { tokens: 184_000, contextWindow: 200_000, percent: 92 },
          surface: "hidden",
          origin: "sdk",
        },
      },
    });

    expect(projection.contextUsage).toEqual({
      tokens: 184_000,
      contextWindow: 200_000,
      percent: 92,
    });

    // Right after a compaction Pi cannot count the context yet — the
    // projection must carry the unknown through, not the stale 92%.
    projection = applySessionProjectionEvent(projection, {
      type: "agent-event-received",
      entry: {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "context_usage",
          runId: "pi-session-1:run-1",
          usage: { tokens: null, contextWindow: 200_000, percent: null },
          surface: "hidden",
          origin: "sdk",
        },
      },
    });

    expect(projection.contextUsage).toEqual({
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    });

    const state: PiSessionState = {
      piSessionId: "pi-session-1",
      runtimeId: "pi-sdk:session-1",
      projectId: "project-1",
      cwd: "/repo",
      status: "idle",
      events: [],
      contextUsage: { tokens: 24_000, contextWindow: 200_000, percent: 12 },
      updatedAt: "2026-07-02T10:05:00.000Z",
    };

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-state-resynced",
      state,
    });

    expect(projection.contextUsage).toEqual({
      tokens: 24_000,
      contextWindow: 200_000,
      percent: 12,
    });
  });

  it("mirrors Gateway-minted chat events into the runtime model but never compat-derived ones", () => {
    let projection = createSessionProjection({
      id: "session-1",
      projectId: "project-1",
      initialPrompt: "Ship it",
      createdAt: "2026-07-02T10:00:00.000Z",
    });

    // User echo minted by the Gateway at command accept.
    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      event: {
        id: "user-echo-1",
        piSessionId: "pi-session-1",
        kind: "message",
        role: "user",
        body: "Ship it",
        messageId: "pi-sdk:pi-session-1:user:0",
        timestamp: "2026-07-02T10:00:00.500Z",
      },
    });

    expect(
      projection.runtimeModel.messages.get("pi-sdk:pi-session-1:user:0"),
    ).toMatchObject({
      role: "user",
      parts: [{ body: "Ship it" }],
    });

    // Steer control echo keeps its label in the model.
    projection = applySessionProjectionEvent(projection, {
      type: "steer-submitted",
      event: {
        id: "steer-echo-1",
        piSessionId: "pi-session-1",
        kind: "control",
        role: "user",
        title: "Steer",
        body: "Focus on tests",
        timestamp: "2026-07-02T10:00:01.000Z",
      },
    });

    expect(projection.runtimeModel.messages.get("steer-echo-1")).toMatchObject({
      role: "user",
      controlLabel: "Steer",
    });

    // Compat-derived legacy events already exist in the model via the agent
    // stream; mirroring them again would duplicate chat content.
    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      event: {
        id: "compat-assistant-1",
        piSessionId: "pi-session-1",
        kind: "message",
        role: "assistant",
        body: "Hello",
        messageId: "pi-session-1:run-1:turn-1:msg-1",
        derivedFromAgentEvent: true,
        timestamp: "2026-07-02T10:00:02.000Z",
      },
    });

    expect(
      projection.runtimeModel.messages.get("pi-session-1:run-1:turn-1:msg-1"),
    ).toBeUndefined();
  });
});

it("restores Pi names from a runtime snapshot", () => {
  const projection = createSessionProjection({ id: "named", projectId: "p", initialPrompt: "Original request", createdAt: "2026-09-07T00:00:00Z" });
  const restored = applySessionProjectionEvent(projection, { type: "runtime-state-resynced", state: {
    piSessionId: "pi-named", runtimeId: "runtime-named", projectId: "p", cwd: "/repo", sessionName: "Recovered name",
    status: "idle", events: [], updatedAt: "2026-09-07T01:00:00Z",
  } });
  expect(getSessionProjectionListItems([restored])[0]?.title).toBe("Recovered name");
});

import { describe, expect, it } from "vitest";
import { PiRuntimeBridgeError } from "@/entities/runtime/pi-runtime-bridge";
import { createInMemoryPiRuntimeBridge } from "@/entities/runtime/in-memory-pi-runtime-bridge";

describe("Pi Runtime Bridge contract", () => {
  it("queues follow-up prompts without adding them to live state until processing starts", async () => {
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const runtime = await bridge.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await bridge.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    const queued = await bridge.queueFollowUp({
      piSessionId: state.piSessionId,
      message: "After this, update the usage tests.",
    });

    await expect(bridge.getSessionState(state.piSessionId)).resolves.toMatchObject({
      events: [],
    });
    expect(queued).toMatchObject({
      piSessionId: state.piSessionId,
      body: "After this, update the usage tests.",
      status: "pending",
    });
  });

  it("withdraws pending queued follow-up prompts before processing starts", async () => {
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const runtime = await bridge.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await bridge.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const queued = await bridge.queueFollowUp({
      piSessionId: state.piSessionId,
      message: "Queue this before the run ends.",
    });

    await expect(
      bridge.withdrawQueuedMessage({
        piSessionId: state.piSessionId,
        queuedMessageId: queued.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [expect.objectContaining({ id: queued.id, status: "withdrawn" })],
    });
  });

  it("steers the current active run without adding a follow-up queue", async () => {
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const runtime = await bridge.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await bridge.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    const steerEvent = await bridge.steerRun({
      piSessionId: state.piSessionId,
      message: "Steer toward the pending queue edge case.",
    });

    expect(steerEvent).toMatchObject({
      piSessionId: state.piSessionId,
      kind: "control",
      role: "user",
      title: "Steer",
      body: "Steer toward the pending queue edge case.",
    });
    await expect(bridge.getSessionState(state.piSessionId)).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          kind: "control",
          title: "Steer",
          body: "Steer toward the pending queue edge case.",
        }),
      ],
    });
  });

  it("aborts the current active run and returns a stopped event", async () => {
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const runtime = await bridge.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await bridge.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    const stoppedEvent = await bridge.abortRun({
      piSessionId: state.piSessionId,
    });

    expect(stoppedEvent).toMatchObject({
      piSessionId: state.piSessionId,
      kind: "status",
      title: "Stopped",
      body: "Pi stopped the active run.",
    });
    await expect(bridge.getSessionState(state.piSessionId)).resolves.toMatchObject({
      status: "completed",
      events: [
        expect.objectContaining({
          kind: "status",
          title: "Stopped",
        }),
      ],
    });
  });

  it("creates Pi Session State and emits the first runtime event after accepting the initial prompt", async () => {
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const runtime = await bridge.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await bridge.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    const accepted = await bridge.sendInitialPrompt({
      piSessionId: state.piSessionId,
      prompt: "Create a resumable live session",
    });

    await expect(bridge.getSessionState(state.piSessionId)).resolves.toMatchObject({
      piSessionId: state.piSessionId,
      status: "running",
      events: [
        expect.objectContaining({
          id: accepted.event.id,
          kind: "message",
          role: "user",
          body: "Create a resumable live session",
          timestamp: "2026-06-26T08:00:00.000Z",
        }),
      ],
    });
    expect(runtime).toMatchObject({
      projectId: "pig",
      status: "ready",
    });
    expect(state).toMatchObject({
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
    });
    expect(accepted).toMatchObject({
      accepted: true,
      piSessionId: state.piSessionId,
    });
  });

  it("reports fake bridge failures with the runtime stage and error detail", async () => {
    const bridge = createInMemoryPiRuntimeBridge({
      failAt: "send-initial-prompt",
      failureMessage: "Pi rejected the initial prompt",
    });
    const runtime = await bridge.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await bridge.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    await expect(
      bridge.sendInitialPrompt({
        piSessionId: state.piSessionId,
        prompt: "Create a resumable live session",
      }),
    ).rejects.toMatchObject({
      name: "PiRuntimeBridgeError",
      stage: "sending prompt",
      message: "Pi rejected the initial prompt",
    });
    await expect(
      bridge.sendInitialPrompt({
        piSessionId: state.piSessionId,
        prompt: "Create a resumable live session",
      }),
    ).rejects.toBeInstanceOf(PiRuntimeBridgeError);
  });

  it("restores fake Pi Session State so projections can resync from runtime truth", async () => {
    const bridge = createInMemoryPiRuntimeBridge();

    await bridge.restoreSessionState({
      piSessionId: "pi-session-restored",
      runtimeId: "runtime-restored",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "completed",
      updatedAt: "2026-06-26T08:00:12.000Z",
      events: [
        {
          id: "runtime-event-1",
          piSessionId: "pi-session-restored",
          kind: "message",
          role: "assistant",
          body: "Recovered runtime state.",
          timestamp: "2026-06-26T08:00:12.000Z",
        },
      ],
    });

    await expect(bridge.getSessionState("pi-session-restored")).resolves.toMatchObject({
      piSessionId: "pi-session-restored",
      status: "completed",
      events: [
        expect.objectContaining({
          body: "Recovered runtime state.",
        }),
      ],
    });
  });
});

import { describe, expect, it } from "vitest";
import { PiRuntimeBridgeError } from "@/entities/runtime/pi-runtime-bridge";
import { createInMemoryPiRuntimeBridge } from "@/entities/runtime/in-memory-pi-runtime-bridge";
import { createPiRpcRuntimeBridge } from "@/entities/runtime/pi-rpc-runtime-bridge";
import { createFakePiRpcTransport } from "@pace/core/testing";

describe("Pi Runtime Bridge contract", () => {
  it("sends the initial prompt through Pi RPC and streams normalized runtime events", async () => {
    const transport = createFakePiRpcTransport({
      sessionId: "pi-session-rpc",
      model: {
        provider: "openai",
        id: "gpt-5-codex",
      },
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const bridge = createPiRpcRuntimeBridge({
      transport,
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
    const observedEvents: unknown[] = [];

    const unsubscribe = bridge.subscribeToEvents(state.piSessionId, (event) => {
      observedEvents.push(event);
    });
    const accepted = await bridge.sendInitialPrompt({
      piSessionId: state.piSessionId,
      prompt: "Create a real Pi RPC-backed session",
    });

    transport.emitEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Live session is ready." }],
        timestamp: 1_782_539_201_000,
      },
    });
    transport.emitEvent({
      type: "tool_execution_start",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: { path: "AGENTS.md" },
    });

    unsubscribe();

    expect(transport.startCalls).toEqual([
      {
        command: "pi",
        args: ["--mode", "rpc", "--session-id", "session-1"],
        cwd: "/Users/void/code/opensource/Pig",
      },
    ]);
    expect(transport.commands).toEqual([
      expect.objectContaining({ type: "get_state" }),
      expect.objectContaining({
        type: "prompt",
        message: "Create a real Pi RPC-backed session",
      }),
    ]);
    expect(runtime).toMatchObject({
      runtimeId: "pi-rpc:session-1",
      status: "ready",
    });
    expect(state).toMatchObject({
      piSessionId: "pi-session-rpc",
      status: "idle",
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
      },
    });
    expect(accepted).toMatchObject({
      accepted: true,
      piSessionId: "pi-session-rpc",
      event: {
        kind: "message",
        role: "user",
        body: "Create a real Pi RPC-backed session",
      },
    });
    expect(observedEvents).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        body: "Live session is ready.",
      }),
      expect.objectContaining({
        kind: "tool-call",
        title: "read",
        body: "{\"path\":\"AGENTS.md\"}",
      }),
    ]);
  });

  it("reports Pi RPC prompt errors as sending prompt failures", async () => {
    const transport = createFakePiRpcTransport({
      sessionId: "pi-session-rpc",
      promptResponse: {
        id: "req-prompt",
        type: "response",
        command: "prompt",
        success: false,
        error: "Pi rejected the initial prompt",
      },
    });
    const bridge = createPiRpcRuntimeBridge({ transport });
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
        prompt: "Create a real Pi RPC-backed session",
      }),
    ).rejects.toMatchObject({
      name: "PiRuntimeBridgeError",
      stage: "sending prompt",
      message: "Pi rejected the initial prompt",
    });
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "prompt",
        message: "Create a real Pi RPC-backed session",
      }),
    );
  });

  it("queues follow-up prompts through Pi RPC without adding them to live state until processing starts", async () => {
    const transport = createFakePiRpcTransport({
      sessionId: "pi-session-rpc",
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const bridge = createPiRpcRuntimeBridge({
      transport,
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
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "prompt",
        message: "After this, update the usage tests.",
        streamingBehavior: "followUp",
      }),
    );
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

  it("steers the current active run through Pi RPC without adding a follow-up queue", async () => {
    const transport = createFakePiRpcTransport({
      sessionId: "pi-session-rpc",
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const bridge = createPiRpcRuntimeBridge({
      transport,
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
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "steer",
        message: "Steer toward the pending queue edge case.",
      }),
    );
    expect(transport.commands).not.toContainEqual(
      expect.objectContaining({
        streamingBehavior: "followUp",
        message: "Steer toward the pending queue edge case.",
      }),
    );
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

  it("aborts the current active run through Pi RPC and returns a stopped event", async () => {
    const transport = createFakePiRpcTransport({
      sessionId: "pi-session-rpc",
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const bridge = createPiRpcRuntimeBridge({
      transport,
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
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        type: "abort",
      }),
    );
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

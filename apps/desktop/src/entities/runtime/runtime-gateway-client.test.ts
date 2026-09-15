import type { RuntimeGatewayEventEnvelope, RuntimeGatewaySnapshot } from "@pace/core";
import type { BackendRpcEvent } from "@pace/backend";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeGatewayClient,
  type RuntimeGatewayClientOptions,
} from "@/entities/runtime/runtime-gateway-client";

describe("Runtime Gateway client", () => {
  it("refreshes runtime controls after the first cold send without turning a refresh failure into a failed submission", async () => {
    let reads = 0;
    const invoke = vi.fn(async <T,>(command: string) => {
      if (command === "get_runtime_snapshot") {
        if (++reads > 1) throw new Error("snapshot unavailable");
        return { sessionId: "app", piSessionId: "pi", runtimeId: "runtime", projectId: "p", cwd: "/repo",
          executionState: "cold", status: "completed", events: [], updatedAt: "2026-09-14T00:00:00.000Z" } as T;
      }
      return { id: "accepted", seq: 1, piSessionId: "pi", sessionId: "app", ts: "2026-09-14T00:01:00.000Z",
        type: "message_update", payload: { kind: "message", role: "user", body: "Continue" } } as T;
    });
    const client = createRuntimeGatewayClient({ invoke: invoke as RuntimeGatewayClientOptions["invoke"], onBackendEvent: () => () => {} });
    await client.loadSession!({ sessionId: "app", piSessionId: "pi" });
    await expect(client.sendInitialPrompt({ piSessionId: "pi", prompt: "Continue" })).resolves.toMatchObject({ accepted: true });
    expect(reads).toBe(2);
    expect(invoke.mock.calls.filter(([command]) => command === "send_prompt")).toHaveLength(1);
  });

  it("merges live events received during a history read in sequence without losing earlier history", async () => {
    let emit!: (event: BackendRpcEvent) => void;
    let resolve!: (snapshot: RuntimeGatewaySnapshot) => void;
    const client = createRuntimeGatewayClient({
      invoke: <T,>() => new Promise<T>(done => { resolve = snapshot => done(snapshot as T); }),
      onBackendEvent: listener => { emit = listener; return () => {}; },
    });
    const event = (seq: number, body: string): RuntimeGatewayEventEnvelope => ({
      id: `evt-${seq}`, seq, sessionId: "app", piSessionId: "pi", type: "message_update",
      ts: `2026-09-14T00:00:0${seq}.000Z`, payload: { kind: "message", role: "user", body },
    });
    client.subscribeToEvents("pi", () => {});
    const reading = client.loadSession!({ sessionId: "app", piSessionId: "pi" });
    emit({ type: "event", event: event(2, "New prompt") });
    resolve({ sessionId: "app", piSessionId: "pi", runtimeId: "runtime", projectId: "p", cwd: "/repo",
      executionState: "cold", status: "completed", events: [event(1, "Old prompt")], updatedAt: "2026-09-14T00:00:01.000Z" });
    const state = await reading;
    expect(state.events.map(entry => entry.body)).toEqual(["Old prompt", "New prompt"]);
    expect(state.replay?.map(entry => entry.kind === "chat" ? entry.seq : entry.entry.seq)).toEqual([1, 2]);
    expect(state.executionState).toBe("ready");
  });

  it("resumes persisted runtime state through the Gateway", async () => {
    const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const snapshot: RuntimeGatewaySnapshot = {
      sessionName: "Recovered Pi name",
      sessionId: "session-resumed",
      runtimeId: "pi-sdk:session-resumed",
      piSessionId: "pi-session-resumed",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
      events: [
        {
          id: "evt-old-user",
          seq: 7,
          sessionId: "session-resumed",
          piSessionId: "pi-session-resumed",
          type: "message_update",
          ts: "2026-07-03T11:00:00.000Z",
          payload: {
            kind: "message",
            role: "user",
            body: "Existing history",
          },
        },
      ],
      updatedAt: "2026-07-03T12:00:00.000Z",
    };
    const invoke: RuntimeGatewayClientOptions["invoke"] = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      invocations.push({ command, args });

      if (command === "resume_session") {
        return snapshot as T;
      }

      throw new Error(`unexpected command ${command}`);
    };
    const client = createRuntimeGatewayClient({
      invoke,
      onBackendEvent: vi.fn(() => vi.fn()),
    });

    const state = await client.resumeSession?.({
      sessionId: "session-resumed",
      projectId: "pig",
      piSessionId: "pi-session-resumed",
      cwd: "/Users/void/code/opensource/Pig",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });

    expect(invocations).toEqual([
      {
        command: "resume_session",
        args: {
          sessionId: "session-resumed",
          projectId: "pig",
          piSessionId: "pi-session-resumed",
          cwd: "/Users/void/code/opensource/Pig",
          sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
          checkout: {
            mode: "foreground-local",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig",
          },
        },
      },
    ]);
    expect(state).toMatchObject({
      sessionName: "Recovered Pi name",
      piSessionId: "pi-session-resumed",
      runtimeId: "pi-sdk:session-resumed",
      events: [
        expect.objectContaining({
          id: "evt-old-user",
          role: "user",
          body: "Existing history",
        }),
      ],
    });
    await expect(client.getSessionState("pi-session-resumed")).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          id: "evt-old-user",
        }),
      ],
    });
  });

  it("configures the selected model pair and updates local runtime state", async () => {
    const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const controls = {
      models: [
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          thinkingLevels: ["off" as const, "high" as const],
        },
      ],
      selected: {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high" as const,
      },
    };
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-controls",
      runtimeId: "pi-sdk:session-controls",
      piSessionId: "pi-session-controls",
      projectId: "pig",
      cwd: "/repo",
      status: "idle",
      events: [],
      modelControls: {
        ...controls,
        selected: { ...controls.selected, thinkingLevel: "off" },
      },
      updatedAt: "2026-07-19T10:00:00.000Z",
    };
    const invoke: RuntimeGatewayClientOptions["invoke"] = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      invocations.push({ command, args });

      if (command === "resume_session") {
        return snapshot as T;
      }

      if (command === "get_runtime_snapshot") {
        return {
          ...snapshot,
          modelControls: controls,
        } as T;
      }

      if (command === "configure_model") {
        return controls as T;
      }

      throw new Error(`unexpected command ${command}`);
    };
    const client = createRuntimeGatewayClient({
      invoke,
      onBackendEvent: vi.fn(() => vi.fn()),
      now: () => "2026-07-19T10:01:00.000Z",
    });

    await client.resumeSession?.({
      sessionId: "session-controls",
      projectId: "pig",
      piSessionId: "pi-session-controls",
      cwd: "/repo",
      sessionFile: "/sessions/pi-session-controls.jsonl",
      checkout: null,
    });
    await expect(
      client.configureModel?.({
        sessionId: "session-controls",
        piSessionId: "pi-session-controls",
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      }),
    ).resolves.toEqual(controls);
    await expect(client.getSessionState("pi-session-controls")).resolves.toMatchObject({
      modelControls: controls,
      summary: {
        provider: "anthropic",
        model: "claude-sonnet-4",
      },
    });
    expect(invocations).toContainEqual({
      command: "configure_model",
      args: {
        sessionId: "session-controls",
        piSessionId: "pi-session-controls",
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      },
    });
  });

  it("forks runtime state through the Gateway and preserves Pi entry identity", async () => {
    const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-forked",
      runtimeId: "pi-sdk:session-forked",
      piSessionId: "pi-session-forked",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig/.pig-worktrees/session-forked",
      status: "idle",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
      events: [
        {
          id: "evt-copied-user",
          seq: 1,
          sessionId: "session-forked",
          piSessionId: "pi-session-forked",
          type: "message_update",
          ts: "2026-07-03T12:10:00.000Z",
          payload: {
            kind: "message",
            role: "user",
            body: "Earlier user",
            messageId: "pi-sdk:pi-session-forked:user:0",
            piEntryId: "pi-entry-user-1",
          },
        },
      ],
      updatedAt: "2026-07-03T12:10:00.000Z",
    };
    const invoke: RuntimeGatewayClientOptions["invoke"] = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      invocations.push({ command, args });

      if (command === "fork_session") {
        return {
          selectedText: "Revise this branch",
          snapshot,
        } as T;
      }

      if (command === "get_runtime_snapshot") {
        return snapshot as T;
      }

      throw new Error(`unexpected command ${command}`);
    };
    const client = createRuntimeGatewayClient({
      invoke,
      onBackendEvent: vi.fn(() => vi.fn()),
    });

    const result = await client.forkSession?.({
      sessionId: "session-forked",
      projectId: "pig",
      sourcePiSessionId: "pi-session-source",
      sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
      piEntryId: "pi-entry-user-2",
      cwd: "/Users/void/code/opensource/Pig/.pig-worktrees/session-forked",
      checkout: {
        mode: "managed-worktree",
        root: "/Users/void/code/opensource/Pig/.pig-worktrees/session-forked",
        runtimeCwd: "/Users/void/code/opensource/Pig/.pig-worktrees/session-forked",
      },
    });

    expect(invocations[0]).toEqual({
      command: "fork_session",
      args: {
        sessionId: "session-forked",
        projectId: "pig",
        sourcePiSessionId: "pi-session-source",
        sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
        piEntryId: "pi-entry-user-2",
        cwd: "/Users/void/code/opensource/Pig/.pig-worktrees/session-forked",
        checkout: {
          mode: "managed-worktree",
          root: "/Users/void/code/opensource/Pig/.pig-worktrees/session-forked",
          runtimeCwd: "/Users/void/code/opensource/Pig/.pig-worktrees/session-forked",
        },
      },
    });
    expect(result).toMatchObject({
      selectedText: "Revise this branch",
      state: {
        piSessionId: "pi-session-forked",
        runtimeId: "pi-sdk:session-forked",
        events: [
          expect.objectContaining({
            id: "evt-copied-user",
            messageId: "pi-sdk:pi-session-forked:user:0",
            piEntryId: "pi-entry-user-1",
          }),
        ],
      },
    });
    await expect(client.getSessionState("pi-session-forked")).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          piEntryId: "pi-entry-user-1",
        }),
      ],
    });
  });

  it("delegates Electron runtime calls to Gateway methods and suppresses command echo events", async () => {
    const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const eventHandlers: Array<(event: BackendRpcEvent) => void> = [];
    const onBackendEvent = vi.fn((handler: (event: BackendRpcEvent) => void) => {
      eventHandlers.push(handler);

      return vi.fn();
    });
    const promptEnvelope: RuntimeGatewayEventEnvelope = {
      id: "evt-user",
      seq: 1,
      sessionId: "session-1",
      piSessionId: "pi-session-1",
      type: "message_update",
      ts: "2026-06-29T12:00:01.000Z",
      payload: {
        kind: "message",
        role: "user",
        body: "Create the Gateway bridge",
      },
    };
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "pi-rpc:session-1",
      piSessionId: "pi-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      events: [],
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
        totalTokens: 0,
        totalCostUsd: 0,
      },
      updatedAt: "2026-06-29T12:00:00.000Z",
    };
    const invoke: RuntimeGatewayClientOptions["invoke"] = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      invocations.push({ command, args });

      if (command === "create_session") {
        return snapshot as T;
      }

      if (command === "send_prompt") {
        eventHandlers[0]?.({ type: "event", event: promptEnvelope });

        return promptEnvelope as T;
      }

      throw new Error(`unexpected command ${command}`);
    };
    const client = createRuntimeGatewayClient({
      invoke,
      onBackendEvent,
      now: () => "2026-06-29T12:00:02.000Z",
    });

    const runtime = await client.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await client.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const observedEvents: unknown[] = [];

    client.subscribeToEvents(state.piSessionId, (event) => {
      observedEvents.push(event);
    });
    const accepted = await client.sendInitialPrompt({
      piSessionId: state.piSessionId,
      prompt: "Create the Gateway bridge",
    });

    eventHandlers[0]?.({
      type: "event",
      event: {
        id: "evt-assistant",
        seq: 2,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "message_update",
        ts: "2026-06-29T12:00:03.000Z",
        payload: {
          kind: "message",
          role: "assistant",
          body: "Gateway bridge is ready.",
        },
      },
    });

    expect(invocations).toEqual([
      {
        command: "create_session",
        args: {
          sessionId: "session-1",
          projectId: "pig",
          cwd: "/Users/void/code/opensource/Pig",
          checkout: {
            mode: "foreground-local",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig",
          },
        },
      },
      {
        command: "send_prompt",
        args: {
          piSessionId: "pi-session-1",
          prompt: "Create the Gateway bridge",
        },
      },
    ]);
    expect(runtime).toMatchObject({
      runtimeId: "pi-rpc:session-1",
      status: "ready",
    });
    expect(state).toMatchObject({
      piSessionId: "pi-session-1",
      status: "idle",
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
      },
    });
    expect(accepted).toMatchObject({
      accepted: true,
      piSessionId: "pi-session-1",
      event: {
        id: "evt-user",
        kind: "message",
        role: "user",
        body: "Create the Gateway bridge",
      },
    });
    expect(observedEvents).toEqual([
      expect.objectContaining({
        id: "evt-assistant",
        kind: "message",
        role: "assistant",
        body: "Gateway bridge is ready.",
      }),
    ]);
    await expect(client.getSessionState("pi-session-1")).resolves.toMatchObject({
      events: [
        expect.objectContaining({ id: "evt-user" }),
        expect.objectContaining({ id: "evt-assistant" }),
      ],
    });
  });

  it("forwards image attachments on send_prompt, queue, and steer", async () => {
    const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const images = [{ mimeType: "image/png", data: "abc", name: "shot.png" }];
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "pi-rpc:session-1",
      piSessionId: "pi-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      events: [],
      updatedAt: "2026-06-29T12:00:00.000Z",
    };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        invocations.push({ command, args });

        if (command === "create_session") {
          return snapshot as T;
        }

        if (command === "send_prompt") {
          return {
            id: "evt-user",
            seq: 1,
            sessionId: "session-1",
            piSessionId: "pi-session-1",
            type: "message_update",
            ts: "2026-06-29T12:00:02.000Z",
            payload: {
              kind: "message",
              role: "user",
              body: args?.prompt,
              images: args?.images,
            },
          } as T;
        }

        if (command === "queue_follow_up") {
          return {
            id: "queued-1",
            piSessionId: "pi-session-1",
            body: args?.message,
            images: args?.images,
            status: "pending",
            createdAt: "2026-06-29T12:00:03.000Z",
          } as T;
        }

        if (command === "steer_run") {
          return {
            id: "evt-steer",
            seq: 2,
            sessionId: "session-1",
            piSessionId: "pi-session-1",
            type: "control",
            ts: "2026-06-29T12:00:04.000Z",
            payload: {
              kind: "control",
              role: "user",
              title: "Steer",
              body: args?.message,
              images: args?.images,
            },
          } as T;
        }

        throw new Error(`unexpected command ${command}`);
      },
    });

    await client.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const accepted = await client.sendInitialPrompt({
      piSessionId: "pi-session-1",
      prompt: "Look at this",
      images,
    });
    const queued = await client.queueFollowUp({
      piSessionId: "pi-session-1",
      message: "And then?",
      images,
    });
    const steered = await client.steerRun({
      piSessionId: "pi-session-1",
      message: "Focus on the screenshot",
      images,
    });

    expect(invocations).toEqual(
      expect.arrayContaining([
        {
          command: "send_prompt",
          args: { piSessionId: "pi-session-1", prompt: "Look at this", images },
        },
        {
          command: "queue_follow_up",
          args: { piSessionId: "pi-session-1", message: "And then?", images },
        },
        {
          command: "steer_run",
          args: {
            piSessionId: "pi-session-1",
            message: "Focus on the screenshot",
            images,
          },
        },
      ]),
    );
    expect(accepted.event.images).toEqual(images);
    expect(queued.images).toEqual(images);
    expect(steered.images).toEqual(images);
  });

  it("preserves Gateway message identity metadata for streaming updates", async () => {
    const eventHandlers: Array<(event: BackendRpcEvent) => void> = [];
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "pi-rpc:session-1",
      piSessionId: "pi-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      events: [],
      updatedAt: "2026-06-29T12:00:00.000Z",
    };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>(command: string) => {
        if (command === "create_session" || command === "get_runtime_snapshot") {
          return snapshot as T;
        }

        throw new Error(`unexpected command ${command}`);
      },
      onBackendEvent: (handler) => {
        eventHandlers.push(handler);

        return vi.fn();
      },
    });
    const runtime = await client.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await client.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const observedEvents: unknown[] = [];

    client.subscribeToEvents(state.piSessionId, (event) => {
      observedEvents.push(event);
    });
    eventHandlers[0]?.({
      type: "event",
      event: {
        id: "evt-assistant-1",
        seq: 1,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "message_update",
        ts: "2026-06-29T12:00:01.000Z",
        payload: {
          kind: "message",
          role: "assistant",
          body: "我们",
          messageId: "pi-sdk:pi-session-1:assistant:0",
        },
      },
    });

    expect(observedEvents).toEqual([
      expect.objectContaining({
        id: "evt-assistant-1",
        messageId: "pi-sdk:pi-session-1:assistant:0",
        body: "我们",
      }),
    ]);
  });

  it("preserves Gateway trace event kinds and tool call identity metadata", async () => {
    const eventHandlers: Array<(event: BackendRpcEvent) => void> = [];
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "pi-rpc:session-1",
      piSessionId: "pi-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      events: [],
      updatedAt: "2026-06-29T12:00:00.000Z",
    };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>(command: string) => {
        if (command === "create_session" || command === "get_runtime_snapshot") {
          return snapshot as T;
        }

        throw new Error(`unexpected command ${command}`);
      },
      onBackendEvent: (handler) => {
        eventHandlers.push(handler);

        return vi.fn();
      },
    });
    const runtime = await client.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await client.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const observedEvents: unknown[] = [];

    client.subscribeToEvents(state.piSessionId, (event) => {
      observedEvents.push(event);
    });
    eventHandlers[0]?.({
      type: "event",
      event: {
        id: "evt-thinking-1",
        seq: 1,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "message_update",
        ts: "2026-06-29T12:00:01.000Z",
        payload: {
          kind: "thinking",
          role: "assistant",
          body: "Inspect context first.",
          messageId: "pi-sdk:pi-session-1:assistant:0",
          phase: "delta",
        },
      },
    });
    eventHandlers[0]?.({
      type: "event",
      event: {
        id: "evt-tool-result-1",
        seq: 2,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "tool_execution_update",
        ts: "2026-06-29T12:00:02.000Z",
        payload: {
          kind: "tool-result",
          title: "read",
          body: "Agent instructions",
          toolCallId: "tool-call-1",
          phase: "final",
        },
      },
    });

    expect(observedEvents).toEqual([
      expect.objectContaining({
        id: "evt-thinking-1",
        kind: "thinking",
        role: "assistant",
        messageId: "pi-sdk:pi-session-1:assistant:0",
        phase: "delta",
        body: "Inspect context first.",
      }),
      expect.objectContaining({
        id: "evt-tool-result-1",
        kind: "tool-result",
        title: "read",
        toolCallId: "tool-call-1",
        phase: "final",
        body: "Agent instructions",
      }),
    ]);
  });

  it("maps Agent Runtime Event Model payloads to legacy runtime events for the current UI", async () => {
    const eventHandlers: Array<(event: BackendRpcEvent) => void> = [];
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      events: [],
      updatedAt: "2026-06-29T12:00:00.000Z",
    };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>(command: string) => {
        if (command === "create_session" || command === "get_runtime_snapshot") {
          return snapshot as T;
        }

        throw new Error(`unexpected command ${command}`);
      },
      onBackendEvent: (handler) => {
        eventHandlers.push(handler);

        return vi.fn();
      },
    });
    const runtime = await client.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await client.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const observedEvents: unknown[] = [];

    client.subscribeToEvents(state.piSessionId, (event) => {
      observedEvents.push(event);
    });

    const runId = "pi-session-1:run-1";
    const turnId = `${runId}:turn-1`;
    const messageId = `${turnId}:msg-1`;
    const partId = `${messageId}:part-0`;
    const agentEnvelopes: RuntimeGatewayEventEnvelope[] = [
      {
        id: "evt-1",
        seq: 1,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "run",
        ts: "2026-06-29T12:00:01.000Z",
        payload: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        id: "evt-2",
        seq: 2,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        turnId,
        type: "turn",
        ts: "2026-06-29T12:00:02.000Z",
        payload: { type: "turn", runId, turnId, phase: "start", surface: "hidden", origin: "sdk" },
      },
      {
        id: "evt-3",
        seq: 3,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        turnId,
        type: "message",
        ts: "2026-06-29T12:00:03.000Z",
        payload: {
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
      {
        id: "evt-4",
        seq: 4,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        turnId,
        type: "message_part",
        ts: "2026-06-29T12:00:04.000Z",
        payload: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "text",
          phase: "update",
          bodyMode: "delta",
          body: "Hel",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        id: "evt-5",
        seq: 5,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        turnId,
        type: "message_part",
        ts: "2026-06-29T12:00:05.000Z",
        payload: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "text",
          phase: "update",
          bodyMode: "delta",
          body: "lo",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        id: "evt-6",
        seq: 6,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        turnId,
        type: "message_part",
        ts: "2026-06-29T12:00:06.000Z",
        payload: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "text",
          phase: "end",
          bodyMode: "snapshot",
          body: "Hello",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        id: "evt-7",
        seq: 7,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        turnId,
        type: "message",
        ts: "2026-06-29T12:00:07.000Z",
        payload: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [{ partId, partType: "text", body: "Hello" }],
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        id: "evt-8",
        seq: 8,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        turnId,
        type: "tool",
        ts: "2026-06-29T12:00:08.000Z",
        payload: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-1",
          phase: "start",
          name: "read_file",
          args: { path: "a.ts" },
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        id: "evt-9",
        seq: 9,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        turnId,
        type: "tool",
        ts: "2026-06-29T12:00:09.000Z",
        payload: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-1",
          phase: "end",
          name: "read_file",
          result: { ok: true },
          isError: false,
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        id: "evt-10",
        seq: 10,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "status",
        ts: "2026-06-29T12:00:10.000Z",
        payload: {
          type: "status",
          runId,
          code: "retrying",
          body: "stream disconnected",
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        id: "evt-11",
        seq: 11,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "run",
        ts: "2026-06-29T12:00:11.000Z",
        payload: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        },
      },
    ];

    for (const envelope of agentEnvelopes) {
      eventHandlers[0]?.({ type: "event", event: envelope });
    }

    expect(observedEvents).toEqual([
      {
        id: "evt-4",
        piSessionId: "pi-session-1",
        kind: "message",
        role: "assistant",
        messageId,
        body: "Hel",
        bodyFormat: "full",
        phase: "delta",
        derivedFromAgentEvent: true,
        timestamp: "2026-06-29T12:00:04.000Z",
      },
      {
        id: "evt-5",
        piSessionId: "pi-session-1",
        kind: "message",
        role: "assistant",
        messageId,
        body: "Hello",
        bodyFormat: "full",
        phase: "delta",
        derivedFromAgentEvent: true,
        timestamp: "2026-06-29T12:00:05.000Z",
      },
      {
        id: "evt-6",
        piSessionId: "pi-session-1",
        kind: "message",
        role: "assistant",
        messageId,
        body: "Hello",
        bodyFormat: "full",
        phase: "final",
        derivedFromAgentEvent: true,
        timestamp: "2026-06-29T12:00:06.000Z",
      },
      {
        id: "evt-8",
        piSessionId: "pi-session-1",
        kind: "tool-call",
        title: "read_file",
        toolCallId: "call-1",
        body: '{"path":"a.ts"}',
        phase: "partial",
        derivedFromAgentEvent: true,
        timestamp: "2026-06-29T12:00:08.000Z",
      },
      {
        id: "evt-9",
        piSessionId: "pi-session-1",
        kind: "tool-result",
        title: "read_file",
        toolCallId: "call-1",
        body: '{"ok":true}',
        phase: "final",
        derivedFromAgentEvent: true,
        timestamp: "2026-06-29T12:00:09.000Z",
      },
      {
        id: "evt-10",
        piSessionId: "pi-session-1",
        kind: "status",
        title: "Retrying",
        body: "stream disconnected",
        derivedFromAgentEvent: true,
        timestamp: "2026-06-29T12:00:10.000Z",
      },
      {
        id: "evt-11",
        piSessionId: "pi-session-1",
        kind: "status",
        title: "Completed",
        body: "Pi SDK runtime ended the active run.",
        derivedFromAgentEvent: true,
        timestamp: "2026-06-29T12:00:11.000Z",
      },
    ]);
  });

  it.each(["workspace.invalidated", "terminal_output", "terminal_exit"])("ignores ephemeral %s before runtime state and deduplication", async (type) => {
    let receive: ((event: BackendRpcEvent) => void) | undefined;
    const snapshot: RuntimeGatewaySnapshot = { sessionId: "session-1", runtimeId: "pi-sdk:session-1", piSessionId: "pi-session-1", projectId: "pig", cwd: "/repo", status: "idle", events: [], updatedAt: "2026-09-05T00:00:00.000Z" };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>() => snapshot as T,
      onBackendEvent: handler => { receive = handler; return vi.fn(); },
    });
    const runtime = await client.startRuntime({ sessionId: "session-1", projectId: "pig", checkout: { mode: "foreground-local", root: "/repo", runtimeCwd: "/repo" } });
    const state = await client.createPiSessionState({ runtimeId: runtime.runtimeId, projectId: "pig", cwd: "/repo" });
    const observed = vi.fn();
    client.subscribeToEvents(state.piSessionId, observed);
    client.subscribeToAgentEvents?.(state.piSessionId, observed);
    const envelope = { id: "shared-id", seq: 0, sessionId: "session-1", piSessionId: state.piSessionId, type, ts: snapshot.updatedAt, payload: { checkoutId: "/repo", sessionIds: ["session-1"], source: "git-watch" } };
    receive?.({ type: "event", event: envelope });
    expect(observed).not.toHaveBeenCalled();
    await expect(client.getSessionState(state.piSessionId)).resolves.toEqual(state);
    // A real event with the same id must not be swallowed by the seen set.
    receive?.({ type: "event", event: { ...envelope, seq: 1, type: "message_update", payload: { kind: "message", role: "user", body: "Real message" } } });
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it("keeps child metadata out of the parent conversation in snapshots and live events", async () => {
    let receive: ((event: BackendRpcEvent) => void) | undefined;
    const event: RuntimeGatewayEventEnvelope = { id: "child-state", seq: 1, sessionId: "session-1", piSessionId: "pi-session-1", type: "subagent_record", ts: "2026-09-13T12:00:00Z", payload: { type: "subagent_record", record: { id: "child" }, surface: "hidden" } };
    const snapshot: RuntimeGatewaySnapshot = { sessionId: "session-1", runtimeId: "runtime-1", piSessionId: "pi-session-1", projectId: "p", cwd: "/repo", status: "idle", events: [event], updatedAt: event.ts };
    const client = createRuntimeGatewayClient({ invoke: async <T,>() => snapshot as T, onBackendEvent: handler => { receive = handler; return vi.fn(); } });
    const runtime = await client.startRuntime({ sessionId: "session-1", projectId: "p", checkout: { mode: "foreground-local", root: "/repo", runtimeCwd: "/repo" } });
    const state = await client.createPiSessionState({ runtimeId: runtime.runtimeId, projectId: "p", cwd: "/repo" });
    expect(state.events).toEqual([]);
    const observed = vi.fn();
    client.subscribeToEvents("pi-session-1", observed);
    client.subscribeToAgentEvents?.("pi-session-1", observed);
    receive?.({ type: "event", event });
    expect(observed).not.toHaveBeenCalled();
  });

  it("keeps contract subagent events out of chat while delivering them to the agent stream", async () => {
    let receive: ((event: BackendRpcEvent) => void) | undefined;
    const event: RuntimeGatewayEventEnvelope = {
      id: "subagent-1",
      seq: 1,
      sessionId: "session-1",
      piSessionId: "pi-session-1",
      type: "subagent",
      ts: "2026-09-15T12:00:00Z",
      payload: {
        type: "subagent",
        phase: "start",
        surface: "hidden",
        origin: "sdk",
        record: {
          childSessionId: "child-1",
          parentSessionId: "pi-session-1",
          ownerToolCallId: "call-1",
          state: "started",
          source: "tintinweb",
          createdAt: "2026-09-15T12:00:00Z",
          updatedAt: "2026-09-15T12:00:00Z",
        },
      },
    };
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "runtime-1",
      piSessionId: "pi-session-1",
      projectId: "p",
      cwd: "/repo",
      status: "idle",
      events: [event],
      updatedAt: event.ts,
    };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>() => snapshot as T,
      onBackendEvent: (handler) => {
        receive = handler;
        return vi.fn();
      },
    });
    const runtime = await client.startRuntime({
      sessionId: "session-1",
      projectId: "p",
      checkout: { mode: "foreground-local", root: "/repo", runtimeCwd: "/repo" },
    });
    const state = await client.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "p",
      cwd: "/repo",
    });
    expect(state.events).toEqual([]);
    const chat = vi.fn();
    const agent = vi.fn();
    client.subscribeToEvents("pi-session-1", chat);
    client.subscribeToAgentEvents?.("pi-session-1", agent);
    receive?.({ type: "event", event });
    expect(chat).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: "subagent", surface: "hidden" }),
      }),
    );
  });

  it("keeps session metadata out of agent and chat timelines", async () => {
    let receive: ((event: BackendRpcEvent) => void) | undefined;
    const snapshot: RuntimeGatewaySnapshot = { sessionId: "session-1", runtimeId: "runtime-1", piSessionId: "pi-session-1", projectId: "p", cwd: "/repo", status: "idle", events: [], updatedAt: "2026-09-07T00:00:00Z" };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>() => snapshot as T,
      onBackendEvent: handler => { receive = handler; return vi.fn(); },
    });
    const observed: unknown[] = [];
    client.subscribeToAgentEvents?.("pi-session-1", event => observed.push(event));
    client.subscribeToEvents("pi-session-1", event => observed.push(event));
    receive?.({ type: "event", event: {
      id: "name", seq: 1, sessionId: "session-1", piSessionId: "pi-session-1", type: "session_info_changed", ts: snapshot.updatedAt,
      payload: { type: "session_info_changed", name: "Auto title", surface: "hidden", origin: "sdk" },
    } });
    expect(observed).toEqual([]);
  });

  it("keeps extension diagnostics visible without turning an idle session into a failed run", async () => {
    let receive: ((event: BackendRpcEvent) => void) | undefined;
    const snapshot: RuntimeGatewaySnapshot = { sessionId: "session-1", runtimeId: "pi-sdk:session-1", piSessionId: "pi-session-1", projectId: "pig", cwd: "/repo", status: "idle", events: [], updatedAt: "2026-09-05T00:00:00.000Z" };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>() => snapshot as T,
      onBackendEvent: handler => { receive = handler; return vi.fn(); },
    });
    const runtime = await client.startRuntime({ sessionId: "session-1", projectId: "pig", checkout: { mode: "foreground-local", root: "/repo", runtimeCwd: "/repo" } });
    const state = await client.createPiSessionState({ runtimeId: runtime.runtimeId, projectId: "pig", cwd: "/repo" });
    const observed: unknown[] = [];
    client.subscribeToEvents(state.piSessionId, event => observed.push(event));
    receive?.({ type: "event", event: {
      id: "extension-error", seq: 1, sessionId: "session-1", piSessionId: state.piSessionId, type: "error", ts: snapshot.updatedAt,
      payload: { type: "error", code: "extension_error", body: "extension handler failed", fatal: false, surface: "chat", origin: "sdk" },
    } });
    expect(observed).toEqual([expect.objectContaining({ kind: "error", title: "Extension error", fatal: false })]);
    await expect(client.getSessionState(state.piSessionId)).resolves.toMatchObject({ status: "idle" });
  });

  it("keeps a failed Active Run failed: maps the chat error and drops the failed run end", async () => {
    const eventHandlers: Array<(event: BackendRpcEvent) => void> = [];
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      events: [],
      updatedAt: "2026-06-29T12:00:00.000Z",
    };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>(command: string) => {
        if (command === "create_session" || command === "get_runtime_snapshot") {
          return snapshot as T;
        }

        throw new Error(`unexpected command ${command}`);
      },
      onBackendEvent: (handler) => {
        eventHandlers.push(handler);

        return vi.fn();
      },
    });
    const runtime = await client.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });
    const state = await client.createPiSessionState({
      runtimeId: runtime.runtimeId,
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const observedEvents: unknown[] = [];

    client.subscribeToEvents(state.piSessionId, (event) => {
      observedEvents.push(event);
    });

    eventHandlers[0]?.({
      type: "event",
      event: {
        id: "evt-error",
        seq: 1,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "error",
        ts: "2026-06-29T12:00:01.000Z",
        payload: {
          type: "error",
          runId: "pi-session-1:run-1",
          code: "run_error",
          body: "model overloaded",
          surface: "chat",
          origin: "sdk",
        },
      },
    });
    eventHandlers[0]?.({
      type: "event",
      event: {
        id: "evt-run-end",
        seq: 2,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "run",
        ts: "2026-06-29T12:00:02.000Z",
        payload: {
          type: "run",
          runId: "pi-session-1:run-1",
          phase: "end",
          trigger: "prompt",
          outcome: "failed",
          surface: "hidden",
          origin: "sdk",
        },
      },
    });

    expect(observedEvents).toEqual([
      {
        id: "evt-error",
        piSessionId: "pi-session-1",
        kind: "error",
        title: "Run failed",
        body: "model overloaded",
        derivedFromAgentEvent: true,
        timestamp: "2026-06-29T12:00:01.000Z",
      },
    ]);
  });

  it("rebuilds a seq-ordered replay sequence from the snapshot's journaled events", async () => {
    const runId = "pi-session-1:run-1";
    const turnId = `${runId}:turn-1`;
    const messageId = `${turnId}:msg-1`;
    const partId = `${messageId}:part-0`;
    const runStartPayload = {
      type: "run",
      runId,
      phase: "start",
      trigger: "prompt",
      surface: "hidden",
      origin: "sdk",
    };
    const partEndPayload = {
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
    };
    const messageEndPayload = {
      type: "message",
      runId,
      turnId,
      messageId,
      role: "assistant",
      phase: "end",
      parts: [{ partId, partType: "text", body: "Hello." }],
      surface: "chat",
      origin: "sdk",
    };
    const runEndPayload = {
      type: "run",
      runId,
      phase: "end",
      trigger: "prompt",
      outcome: "completed",
      surface: "hidden",
      origin: "sdk",
    };
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "completed",
      events: [
        {
          id: "evt-user",
          seq: 1,
          sessionId: "session-1",
          piSessionId: "pi-session-1",
          type: "message_update",
          ts: "2026-07-03T10:00:01.000Z",
          payload: { kind: "message", role: "user", body: "Fix the bug" },
        },
        {
          id: "evt-run-start",
          seq: 2,
          sessionId: "session-1",
          piSessionId: "pi-session-1",
          type: "run",
          ts: "2026-07-03T10:00:02.000Z",
          payload: runStartPayload,
        },
        {
          id: "evt-part-end",
          seq: 3,
          sessionId: "session-1",
          piSessionId: "pi-session-1",
          turnId,
          type: "message_part",
          ts: "2026-07-03T10:00:03.000Z",
          payload: partEndPayload,
        },
        {
          id: "evt-message-end",
          seq: 4,
          sessionId: "session-1",
          piSessionId: "pi-session-1",
          turnId,
          type: "message",
          ts: "2026-07-03T10:00:04.000Z",
          payload: messageEndPayload,
        },
        {
          id: "evt-run-end",
          seq: 5,
          sessionId: "session-1",
          piSessionId: "pi-session-1",
          type: "run",
          ts: "2026-07-03T10:00:05.000Z",
          payload: runEndPayload,
        },
      ],
      updatedAt: "2026-07-03T10:00:05.000Z",
    };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>(command: string) => {
        if (command === "get_runtime_snapshot") {
          return snapshot as T;
        }

        throw new Error(`unexpected command ${command}`);
      },
      onBackendEvent: () => vi.fn(),
    });

    const state = await client.getSessionState("pi-session-1");

    // The mixed replay sequence keeps Gateway seq order so the projection can
    // interleave agent events and Gateway-minted chat events faithfully.
    expect(state.replay).toEqual([
      {
        kind: "chat",
        seq: 1,
        event: expect.objectContaining({
          id: "evt-user",
          kind: "message",
          role: "user",
          body: "Fix the bug",
        }),
      },
      {
        kind: "agent",
        entry: { seq: 2, timestamp: "2026-07-03T10:00:02.000Z", event: runStartPayload },
      },
      {
        kind: "agent",
        entry: { seq: 3, timestamp: "2026-07-03T10:00:03.000Z", event: partEndPayload },
      },
      {
        kind: "agent",
        entry: { seq: 4, timestamp: "2026-07-03T10:00:04.000Z", event: messageEndPayload },
      },
      {
        kind: "agent",
        entry: { seq: 5, timestamp: "2026-07-03T10:00:05.000Z", event: runEndPayload },
      },
    ]);
    // The legacy folded view stays intact for the fallback rendering path.
    expect(state.events).toEqual([
      expect.objectContaining({ id: "evt-user", kind: "message", role: "user" }),
      expect.objectContaining({
        id: "evt-part-end",
        kind: "message",
        body: "Hello.",
        derivedFromAgentEvent: true,
      }),
      expect.objectContaining({ id: "evt-run-end", kind: "status", title: "Completed" }),
    ]);
  });

  it("exposes the Agent Runtime Event stream with seq for the structured projection", async () => {
    const eventHandlers: Array<(event: BackendRpcEvent) => void> = [];
    const snapshot: RuntimeGatewaySnapshot = {
      sessionId: "session-1",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      events: [],
      updatedAt: "2026-06-29T12:00:00.000Z",
    };
    const client = createRuntimeGatewayClient({
      invoke: async <T,>(command: string) => {
        if (command === "create_session" || command === "get_runtime_snapshot") {
          return snapshot as T;
        }

        throw new Error(`unexpected command ${command}`);
      },
      onBackendEvent: (handler) => {
        eventHandlers.push(handler);

        return vi.fn();
      },
    });

    await client.startRuntime({
      sessionId: "session-1",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });

    const observedEntries: unknown[] = [];

    client.subscribeToAgentEvents?.("pi-session-1", (entry) => {
      observedEntries.push(entry);
    });

    const runPayload = {
      type: "run",
      runId: "pi-session-1:run-1",
      phase: "start",
      trigger: "prompt",
      surface: "hidden",
      origin: "sdk",
    };

    eventHandlers[0]?.({
      type: "event",
      event: {
        id: "evt-run",
        seq: 7,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "run",
        ts: "2026-06-29T12:00:01.000Z",
        payload: runPayload,
      },
    });
    // Legacy command-echo envelopes never reach the agent event stream.
    eventHandlers[0]?.({
      type: "event",
      event: {
        id: "evt-legacy",
        seq: 8,
        sessionId: "session-1",
        piSessionId: "pi-session-1",
        type: "message_update",
        ts: "2026-06-29T12:00:02.000Z",
        payload: { kind: "message", role: "user", body: "Hello Pi" },
      },
    });

    expect(observedEntries).toEqual([
      {
        seq: 7,
        timestamp: "2026-06-29T12:00:01.000Z",
        event: runPayload,
      },
    ]);
  });

  it("prepares a chat workspace through the Gateway", async () => {
    const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: RuntimeGatewayClientOptions["invoke"] = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      invocations.push({ command, args });

      if (command === "prepare_chat_workspace") {
        return { cwd: "/tmp/pigui/chats/session-1" } as T;
      }

      throw new Error(`unexpected command ${command}`);
    };
    const client = createRuntimeGatewayClient({
      invoke,
      onBackendEvent: vi.fn(() => vi.fn()),
    });

    await expect(client.prepareChatWorkspace({ sessionId: "session-1" })).resolves.toEqual({
      cwd: "/tmp/pigui/chats/session-1",
    });
    expect(invocations).toEqual([
      { command: "prepare_chat_workspace", args: { sessionId: "session-1" } },
    ]);
  });
});

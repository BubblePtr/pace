import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as afterMicrotasks } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeGatewayService,
  type PiRuntimeDriver,
  type RuntimeGatewayDriverEvent,
} from "./runtime-gateway";
import { createInMemorySessionEventJournal } from "../persistence/session-event-journal";
import { createInMemorySessionProjectionStore } from "../persistence/session-projection-store";
import { createPiSdkDriver } from "../drivers/pi-sdk-driver";
import { createPublicPiSdkRuntimeFactory, createPublicPiSdkRuntimeResumer } from "../drivers/pi-sdk-runtime-adapter";
import { createRuntimeGatewayClient } from "@/entities/runtime/runtime-gateway-client";
import { createSessionFromDraft, createInMemorySessionProjectionStore as createDraftProjectionStore } from "@/entities/session/session-creation";

let defaultDataDir: string;
beforeEach(async () => {
  defaultDataDir = await mkdtemp(join(tmpdir(), "pace-gateway-default-"));
  vi.stubEnv("PACE_DATA_DIR", defaultDataDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(defaultDataDir, { recursive: true, force: true });
});

function createFakeRuntimeDriver(): PiRuntimeDriver & {
  emitDriverEvent(event: RuntimeGatewayDriverEvent): void;
} {
  const driverListeners = new Set<(event: RuntimeGatewayDriverEvent) => void>();

  return {
    emitDriverEvent(event) {
      for (const listener of driverListeners) {
        listener(event);
      }
    },
    async createSession(input) {
      return {
        sessionId: input.sessionId,
        runtimeId: `runtime:${input.sessionId}`,
        piSessionId: "pi-session-1",
        projectId: input.projectId,
        cwd: input.cwd,
        status: "idle",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-1.jsonl",
        events: [],
        summary: {
          provider: "openai",
          model: "gpt-5-codex",
          totalTokens: 0,
          totalCostUsd: 0,
        },
        updatedAt: "2026-06-29T12:00:00.000Z",
      };
    },
    async resumeSession(input) {
      return {
        sessionId: input.sessionId,
        runtimeId: `runtime:${input.sessionId}`,
        piSessionId: input.piSessionId,
        projectId: input.projectId,
        cwd: input.cwd,
        status: "idle",
        sessionFile: input.sessionFile,
        checkout: input.checkout,
        events: [],
        summary: {
          provider: "openai",
          model: "gpt-5-codex",
          totalTokens: 42,
          totalCostUsd: 0.001,
        },
        updatedAt: "2026-07-03T12:00:00.000Z",
      };
    },
    async forkSession(input) {
      return {
        selectedText: "Revise this branch",
        snapshot: {
          sessionId: input.sessionId,
          runtimeId: `runtime:${input.sessionId}`,
          piSessionId: "pi-session-forked",
          projectId: input.projectId,
          cwd: input.cwd,
          status: "idle",
          sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
          checkout: input.checkout,
          events: [],
          summary: {
            provider: "openai",
            model: "gpt-5-codex",
            totalTokens: 42,
            totalCostUsd: 0.001,
          },
          updatedAt: "2026-07-03T12:10:00.000Z",
        },
      };
    },
    async sendPrompt(input) {
      return {
        piSessionId: input.piSessionId,
        type: "message_update",
        payload: {
          kind: "message",
          role: "user",
          body: input.prompt,
        },
      };
    },
    async queueFollowUp(input) {
      return {
        id: "queued-1",
        piSessionId: input.piSessionId,
        body: input.message,
        status: "pending",
        createdAt: "2026-06-29T12:00:00.000Z",
      };
    },
    async withdrawQueuedMessage(input) {
      return {
        id: input.queuedMessageId,
        piSessionId: input.piSessionId,
        body: "queued",
        status: "withdrawn",
        createdAt: "2026-06-29T12:00:00.000Z",
        withdrawnAt: "2026-06-29T12:00:00.000Z",
      };
    },
    async steerRun(input) {
      return {
        piSessionId: input.piSessionId,
        type: "control",
        payload: {
          kind: "control",
          role: "user",
          title: "Steer",
          body: input.message,
        },
      };
    },
    async stopRun(input) {
      return {
        piSessionId: input.piSessionId,
        type: "status",
        payload: {
          kind: "status",
          title: "Stopped",
          body: "Pi stopped the active run.",
        },
      };
    },
    async configureModel(input) {
      return {
        models: [
          {
            provider: input.provider,
            modelId: input.modelId,
            name: "Claude Sonnet 4",
            thinkingLevels: ["off", "low", "medium", "high"],
          },
        ],
        selected: {
          provider: input.provider,
          modelId: input.modelId,
          thinkingLevel: input.thinkingLevel,
        },
      };
    },
    async getSnapshot(piSessionId) {
      return {
        sessionId: "app-session-1",
        runtimeId: "runtime:app-session-1",
        piSessionId,
        projectId: "pig",
        cwd: "/repo",
        status: "idle",
        events: [],
        updatedAt: "2026-06-29T12:00:00.000Z",
      };
    },
    onEvent(listener) {
      driverListeners.add(listener);

      return () => {
        driverListeners.delete(listener);
      };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("reads cold history without initializing Pi, even when execution dependencies are broken", async () => {
  const resume = vi.fn(async () => { throw new Error("extension initialization failed"); });
  const driver = createPiSdkDriver({ runtimeResumer: resume });
  const projections = createInMemorySessionProjectionStore();
  const journal = createInMemorySessionEventJournal();
  await projections.save({ sessionId: "cold", runtimeId: "pi-sdk:cold", piSessionId: "pi-cold",
    projectId: "chat", cwd: join(defaultDataDir, "missing-cwd"), status: "completed",
    sessionFile: "/missing/pi.jsonl", updatedAt: "2026-09-14T00:00:00.000Z" });
  journal.append({ id: "history", seq: 42, sessionId: "cold", piSessionId: "pi-cold",
    type: "message_update", ts: "2026-09-14T00:00:00.000Z",
    payload: { kind: "message", role: "assistant", body: "Saved answer" } });
  const gateway = createRuntimeGatewayService({ driver, projections, journal });

  const response = await gateway.handleRequest({ id: "open", method: "get_runtime_snapshot",
    params: { sessionId: "cold", piSessionId: "pi-cold" } });

  expect(response.error).toBeUndefined();
  expect(response.result).toMatchObject({ executionState: "cold", events: [
    expect.objectContaining({ seq: 42, payload: expect.objectContaining({ body: "Saved answer" }) }),
  ] });
  expect(resume).not.toHaveBeenCalled();
  await expect(stat(join(defaultDataDir, "missing-cwd"))).rejects.toThrow();
});

it("prepares a cold Session once for concurrent commands and keeps history readable during preparation", async () => {
  const entered = deferred();
  const release = deferred();
  const prompts: string[] = [];
  const resume = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { piSessionId: "pi-cold", runtimeId: "pi-sdk:cold", status: "idle" as const,
      seedPromptCount: 3, sendPrompt: async (prompt: string) => { prompts.push(prompt); } };
  });
  const driver = createPiSdkDriver({ runtimeResumer: resume });
  const projections = createInMemorySessionProjectionStore();
  const journal = createInMemorySessionEventJournal();
  await projections.save({ sessionId: "cold", runtimeId: "pi-sdk:cold", piSessionId: "pi-cold",
    projectId: "project", cwd: "/repo", status: "completed", sessionFile: "/pi.jsonl",
    updatedAt: "2026-09-14T00:00:00.000Z" });
  journal.append({ id: "history", seq: 42, sessionId: "cold", piSessionId: "pi-cold",
    type: "message_update", ts: "2026-09-14T00:00:00.000Z", payload: { kind: "message", role: "user", body: "old" } });
  const gateway = createRuntimeGatewayService({ driver, projections, journal });
  const first = gateway.handleRequest({ id: "send-1", method: "send_prompt", params: { piSessionId: "pi-cold", prompt: "first" } });
  // A broken implementation can reject before reaching the gate.
  await Promise.race([entered.promise, first]);
  const second = gateway.handleRequest({ id: "send-2", method: "send_prompt", params: { sessionId: "cold", piSessionId: "pi-cold", prompt: "second" } });
  const history = await gateway.handleRequest({ id: "open", method: "get_runtime_snapshot", params: { sessionId: "cold", piSessionId: "pi-cold" } });
  expect(history).toMatchObject({ result: { executionState: "cold", events: [expect.objectContaining({ seq: 42 })] } });
  expect(prompts).toEqual([]);
  release.resolve();
  const responses = await Promise.all([first, second]);
  expect(responses.map(response => response.error)).toEqual([undefined, undefined]);
  expect(resume).toHaveBeenCalledOnce();
  expect(prompts).toEqual(["first", "second"]);
  expect(responses.map(response => (response.result as { seq: number }).seq)).toEqual([43, 44]);
  expect((responses[0].result as { payload: { messageId: string } }).payload.messageId).toBe("pi-sdk:pi-cold:user:3");
});

it("shares a failed SDK initialization, then retries extensions and submits only the retried prompt", async () => {
  const entered = deferred();
  const release = deferred();
  const bindExtensions = vi.fn().mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; throw new Error("Extension failed to start");
  }).mockResolvedValue(undefined);
  const prompt = vi.fn(async () => {});
  const dispose = vi.fn();
  const manager = { getCwd: () => "/repo", getSessionFile: () => "/pi.jsonl" };
  const createAgentSession = vi.fn(async () => ({ session: {
    sessionId: "pi-cold", messages: [], isStreaming: false, sessionManager: manager,
    bindExtensions, prompt, abort: async () => {}, dispose, subscribe: () => () => {},
  } }));
  const driver = createPiSdkDriver({ runtimeResumer: createPublicPiSdkRuntimeResumer({ sdk: {
    SessionManager: { open: () => manager }, createAgentSession,
  } }) });
  const projections = createInMemorySessionProjectionStore();
  await projections.save({ sessionId: "cold", runtimeId: "runtime", piSessionId: "pi-cold", projectId: "p",
    cwd: "/repo", status: "completed", sessionFile: "/pi.jsonl", updatedAt: "2026-09-14T00:00:00.000Z" });
  const gateway = createRuntimeGatewayService({ driver, projections, journal: createInMemorySessionEventJournal() });
  const open = () => gateway.handleRequest({ id: "open", method: "get_runtime_snapshot", params: { piSessionId: "pi-cold" } });
  await open();
  expect(createAgentSession).not.toHaveBeenCalled();
  expect(bindExtensions).not.toHaveBeenCalled();
  const send = (id: string) => gateway.handleRequest({ id, method: "send_prompt", params: { piSessionId: "pi-cold", prompt: id } });
  const first = send("first");
  await entered.promise;
  const second = send("second");
  await open();
  release.resolve();
  expect((await Promise.all([first, second])).map(response => response.error)).toEqual([
    "Extension failed to start", "Extension failed to start",
  ]);
  expect(createAgentSession).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(prompt).not.toHaveBeenCalled();
  expect(await open()).toMatchObject({ result: { executionState: "cold" } });
  expect(await send("retry")).not.toHaveProperty("error");
  expect(createAgentSession).toHaveBeenCalledTimes(2);
  expect(bindExtensions).toHaveBeenCalledTimes(2);
  expect(prompt).toHaveBeenCalledExactlyOnceWith("retry");
  await driver.dispose?.();
});

it("journals recoverable extension errors without failing the active session", async () => {
  const driver = createFakeRuntimeDriver();
  const journal = createInMemorySessionEventJournal();
  const projections = createInMemorySessionProjectionStore();
  const gateway = createRuntimeGatewayService({ driver, journal, projections });
  await gateway.handleRequest({ id: "create", method: "create_session", params: { sessionId: "extension-session", projectId: "p", cwd: "/project" } });
  driver.emitDriverEvent({
    piSessionId: "pi-session-1", type: "error",
    payload: { type: "error", code: "extension_error", body: "extension handler failed", fatal: false, origin: "sdk", surface: "chat" },
  });
  await gateway.handleRequest({ id: "snapshot", method: "get_runtime_snapshot", params: { piSessionId: "pi-session-1" } });
  expect(await journal.read("pi-session-1")).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ body: "extension handler failed" }) })]));
  expect(await projections.get("extension-session")).toMatchObject({ status: "idle" });
});

it.each(["create_session", "resume_session", "fork_session"] as const)("includes startup errors in the first %s response after existing history", async (method) => {
  const driver = createFakeRuntimeDriver();
  const journal = createInMemorySessionEventJournal();
  const projections = createInMemorySessionProjectionStore();
  const gateway = createRuntimeGatewayService({ driver, journal, projections });
  const diagnostic = (piSessionId: string) => driver.emitDriverEvent({
    sessionId: "initializing", piSessionId, type: "error",
    payload: { type: "error", code: "extension_load_error", body: "startup diagnostic", fatal: false, origin: "sdk", surface: "chat" },
  });
  const originalCreate = driver.createSession;
  driver.createSession = async input => { const snapshot = await originalCreate(input); diagnostic(snapshot.piSessionId); return snapshot; };
  const originalResume = driver.resumeSession;
  driver.resumeSession = async input => { const snapshot = await originalResume(input); diagnostic(snapshot.piSessionId); return snapshot; };
  const originalFork = driver.forkSession;
  driver.forkSession = async input => { const result = await originalFork(input); diagnostic(result.snapshot.piSessionId); return result; };
  journal.append({ id: "source-user", seq: 1, sessionId: "source", piSessionId: "source-pi", type: "message_update", ts: "2026-09-05T00:00:00.000Z", payload: { kind: "message", role: "user", body: "fork here", piEntryId: "fork-point" } });
  const response = await gateway.handleRequest({ id: "start", method, params: {
    sessionId: "initializing", projectId: "p", cwd: "/project", piSessionId: "pi-session-1", sessionFile: "/session.jsonl", sourcePiSessionId: "source-pi", sourceSessionFile: "/source.jsonl", piEntryId: "fork-point",
  } });
  expect(response.error).toBeUndefined();
  const result = response.result as { events?: Array<{ payload: Record<string, unknown> }>; snapshot?: { events: Array<{ payload: Record<string, unknown> }> } };
  const events = result.snapshot?.events ?? result.events ?? [];
  expect(events[events.length - 1]?.payload.body).toBe("startup diagnostic");
  if (method === "fork_session") expect(events[0]?.payload.kind).toBe("fork");
});

function agentEvent(
  piSessionId: string,
  payload: Record<string, unknown>,
): RuntimeGatewayDriverEvent {
  return {
    piSessionId,
    type: String(payload.type),
    payload: { origin: "sdk", ...payload },
  };
}

describe("Runtime Gateway service", () => {
  it("carries the Draft model through the client and gateway into Pi creation without resetting it", async () => {
    const model = { provider: "custom", id: "composer", name: "Composer", reasoning: true };
    const selection = { provider: "custom", modelId: "composer", thinkingLevel: "high" as const };
    const modelRuntime = { getModel: () => model, getAvailableSnapshot: () => [model] };
    const session = {
      sessionId: "pi-composer", isStreaming: false, messages: [], model, thinkingLevel: "high",
      modelRuntime, setModel: vi.fn(async () => {}), setThinkingLevel: vi.fn(),
      prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(), subscribe: () => () => {},
    };
    const createAgentSession = vi.fn(async () => ({ session }));
    const driver = createPiSdkDriver({ runtimeFactory: createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession, ModelRuntime: { create: async () => modelRuntime } },
    }) });
    const gateway = createRuntimeGatewayService({ driver });
    const bridge = createRuntimeGatewayClient({
      invoke: async <T,>(method: string, params?: Record<string, unknown>) => {
        const response = await gateway.handleRequest({ id: method, method, params });
        if (response.error) throw new Error(response.error);
        return response.result as T;
      },
      onBackendEvent: listener => gateway.onEvent(listener),
    });
    const result = await createSessionFromDraft({
      bridge, projections: createDraftProjectionStore(), modelSelection: selection,
      draft: { projectId: "p", prompt: "Hello", updatedAt: "2026-09-16T00:00:00.000Z" },
      project: { id: "p", projectRoot: "/repo" }, idFactory: () => "app-composer",
    });
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ model, thinkingLevel: "high" }));
    expect(session.prompt).toHaveBeenCalledWith("Hello");
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) result.unsubscribeRuntimeEvents();
    await driver.dispose?.();
  });

  it("dispatches Pace runtime methods and emits product event envelopes", async () => {
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      now: () => "2026-06-29T12:00:00.000Z",
      idFactory: () => "evt-fixed",
    });
    const events: unknown[] = [];

    service.onEvent((event) => events.push(event));

    await expect(
      service.handleRequest({
        id: "req-create",
        method: "create_session",
        params: {
          sessionId: "app-session-1",
          projectId: "pig",
          cwd: "/repo",
        },
      }),
    ).resolves.toEqual({
      id: "req-create",
      result: expect.objectContaining({
        runtimeId: "runtime:app-session-1",
        piSessionId: "pi-session-1",
      }),
    });

    await expect(
      service.handleRequest({
        id: "req-prompt",
        method: "send_prompt",
        params: {
          piSessionId: "pi-session-1",
          prompt: "Build the gateway.",
        },
      }),
    ).resolves.toEqual({
      id: "req-prompt",
      result: expect.objectContaining({
        seq: 1,
        sessionId: "app-session-1",
        piSessionId: "pi-session-1",
        type: "message_update",
      }),
    });

    expect(events).toEqual([
      {
        type: "event",
        event: expect.objectContaining({
          id: "evt-fixed",
          seq: 1,
          sessionId: "app-session-1",
          piSessionId: "pi-session-1",
          type: "message_update",
          payload: expect.objectContaining({
            body: "Build the gateway.",
          }),
        }),
      },
    ]);
  });

  it("forwards image attachments on send_prompt, queue_follow_up, and steer_run", async () => {
    const driver = createFakeRuntimeDriver();
    const sendPrompt = vi.spyOn(driver, "sendPrompt");
    const queueFollowUp = vi.spyOn(driver, "queueFollowUp");
    const steerRun = vi.spyOn(driver, "steerRun");
    const service = createRuntimeGatewayService({
      driver,
      now: () => "2026-06-29T12:00:00.000Z",
      idFactory: () => "evt-fixed",
    });
    const images = [{ mimeType: "image/png", data: "abc", name: "shot.png" }];

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: {
        sessionId: "app-session-1",
        projectId: "pig",
        cwd: "/repo",
      },
    });
    await service.handleRequest({
      id: "req-prompt",
      method: "send_prompt",
      params: {
        piSessionId: "pi-session-1",
        prompt: "Look at this",
        images,
      },
    });
    await service.handleRequest({
      id: "req-queue",
      method: "queue_follow_up",
      params: {
        piSessionId: "pi-session-1",
        message: "And then?",
        images,
      },
    });
    await service.handleRequest({
      id: "req-steer",
      method: "steer_run",
      params: {
        piSessionId: "pi-session-1",
        message: "Focus on the screenshot",
        images,
      },
    });

    expect(sendPrompt).toHaveBeenCalledWith({
      piSessionId: "pi-session-1",
      prompt: "Look at this",
      images,
    });
    expect(queueFollowUp).toHaveBeenCalledWith({
      piSessionId: "pi-session-1",
      message: "And then?",
      images,
    });
    expect(steerRun).toHaveBeenCalledWith({
      piSessionId: "pi-session-1",
      message: "Focus on the screenshot",
      images,
    });
  });

  it("accepts an image-only send_prompt", async () => {
    const driver = createFakeRuntimeDriver();
    const sendPrompt = vi.spyOn(driver, "sendPrompt");
    const service = createRuntimeGatewayService({
      driver,
      now: () => "2026-06-29T12:00:00.000Z",
      idFactory: () => "evt-fixed",
    });
    const images = [{ mimeType: "image/png", data: "abc", name: "shot.png" }];

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: {
        sessionId: "app-session-1",
        projectId: "pig",
        cwd: "/repo",
      },
    });
    await service.handleRequest({
      id: "req-prompt",
      method: "send_prompt",
      params: {
        piSessionId: "pi-session-1",
        prompt: "",
        images,
      },
    });

    expect(sendPrompt).toHaveBeenCalledWith({
      piSessionId: "pi-session-1",
      prompt: "",
      images,
    });
  });

  it("serves the journaled boundary events from get_runtime_snapshot, without streaming deltas", async () => {
    const driver = createFakeRuntimeDriver();
    let idCounter = 0;
    const service = createRuntimeGatewayService({
      driver,
      journal: createInMemorySessionEventJournal(),
      now: () => "2026-07-03T10:00:00.000Z",
      idFactory: () => `evt-${(idCounter += 1)}`,
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "pig", cwd: "/repo" },
    });
    // The minted user echo (seq 1) must be journaled: user messages live only
    // on this stream until the §10 protocol gap is settled.
    await service.handleRequest({
      id: "req-prompt",
      method: "send_prompt",
      params: { piSessionId: "pi-session-1", prompt: "Fix the bug" },
    });

    driver.emitDriverEvent(
      agentEvent("pi-session-1", {
        type: "run",
        runId: "pi-session-1:run-1",
        phase: "start",
        trigger: "prompt",
        surface: "hidden",
      }),
    );
    driver.emitDriverEvent(
      agentEvent("pi-session-1", {
        type: "message_part",
        runId: "pi-session-1:run-1",
        turnId: "pi-session-1:run-1:turn-1",
        messageId: "pi-session-1:run-1:turn-1:msg-1",
        partId: "pi-session-1:run-1:turn-1:msg-1:part-0",
        partType: "text",
        phase: "start",
        bodyMode: "snapshot",
        body: "",
        surface: "chat",
      }),
    );
    driver.emitDriverEvent(
      agentEvent("pi-session-1", {
        type: "message_part",
        runId: "pi-session-1:run-1",
        turnId: "pi-session-1:run-1:turn-1",
        messageId: "pi-session-1:run-1:turn-1:msg-1",
        partId: "pi-session-1:run-1:turn-1:msg-1:part-0",
        partType: "text",
        phase: "update",
        bodyMode: "delta",
        body: "Hello",
        surface: "chat",
      }),
    );
    driver.emitDriverEvent(
      agentEvent("pi-session-1", {
        type: "message_part",
        runId: "pi-session-1:run-1",
        turnId: "pi-session-1:run-1:turn-1",
        messageId: "pi-session-1:run-1:turn-1:msg-1",
        partId: "pi-session-1:run-1:turn-1:msg-1:part-0",
        partType: "text",
        phase: "end",
        bodyMode: "snapshot",
        body: "Hello.",
        surface: "chat",
      }),
    );
    driver.emitDriverEvent(
      agentEvent("pi-session-1", {
        type: "run",
        runId: "pi-session-1:run-1",
        phase: "end",
        trigger: "prompt",
        outcome: "completed",
        surface: "hidden",
      }),
    );

    const response = await service.handleRequest({
      id: "req-snapshot",
      method: "get_runtime_snapshot",
      params: { piSessionId: "pi-session-1" },
    });
    const snapshot = response.result as {
      status: string;
      events: Array<{ seq: number; payload: Record<string, unknown> }>;
    };

    expect(snapshot.status).toBe("idle");
    expect(snapshot.events.map((event) => event.seq)).toEqual([1, 2, 3, 5, 6]);
    expect(snapshot.events[0]?.payload).toEqual(
      expect.objectContaining({ kind: "message", role: "user", body: "Fix the bug" }),
    );
    expect(
      snapshot.events.some(
        (event) =>
          event.payload.type === "message_part" && event.payload.phase === "update",
      ),
    ).toBe(false);
  });

  it("persists Session Projection records when SDK sessions are created", async () => {
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
      now: () => "2026-07-03T10:00:00.000Z",
      idFactory: () => "evt-fixed",
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: {
        sessionId: "app-session-1",
        projectId: "pig",
        cwd: "/repo",
      },
    });
    await service.handleRequest({
      id: "req-prompt",
      method: "send_prompt",
      params: {
        piSessionId: "pi-session-1",
        prompt: "Persist this title",
      },
    });

    await expect(projections.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "app-session-1",
        initialPrompt: "Persist this title",
        runtimeId: "runtime:app-session-1",
        piSessionId: "pi-session-1",
        projectId: "pig",
        cwd: "/repo",
        status: "running",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-1.jsonl",
      }),
    ]);
  });

  it.each(["send_prompt", "queue_follow_up", "steer_run"])(
    "persists %s submission time without bumping it on background activity or resume",
    async (method) => {
      const projections = createInMemorySessionProjectionStore();
      const driver = createFakeRuntimeDriver();
      let now = "2026-07-03T10:00:00.000Z";
      const service = createRuntimeGatewayService({ driver, projections, now: () => now });
      await service.handleRequest({
        id: "create",
        method: "create_session",
        params: { sessionId: "app-session-1", projectId: "pig", cwd: "/repo" },
      });
      expect(await projections.get("app-session-1")).toMatchObject({
        lastUserMessageAt: "2026-06-29T12:00:00.000Z",
      });
      const response = await service.handleRequest({
        id: "submit",
        method,
        params: { piSessionId: "pi-session-1", prompt: "Continue", message: "Continue" },
      });
      expect(response.error).toBeUndefined();
      expect(await projections.get("app-session-1")).toMatchObject({ lastUserMessageAt: now });

      now = "2026-07-03T11:00:00.000Z";
      driver.emitDriverEvent({
        piSessionId: "pi-session-1",
        type: "message_update",
        payload: { kind: "message", role: "user", body: "Delayed queued echo" },
      });
      driver.emitDriverEvent({
        piSessionId: "pi-session-1",
        type: "message_update",
        payload: { kind: "message", role: "assistant", body: "Still working" },
      });
      // A successful stop also flushes queued runtime writes before the assertion.
      const stopped = await service.handleRequest({
        id: "stop", method: "stop_run", params: { piSessionId: "pi-session-1" },
      });
      expect(stopped.error).toBeUndefined();
      expect(await projections.get("app-session-1")).toMatchObject({
        lastUserMessageAt: "2026-07-03T10:00:00.000Z",
      });
      const resumed = await service.handleRequest({
        id: "resume",
        method: "resume_session",
        params: {
          sessionId: "app-session-1", piSessionId: "pi-session-1", projectId: "pig",
          cwd: "/repo", sessionFile: "/tmp/session.jsonl",
        },
      });
      expect(resumed.error).toBeUndefined();
      expect(await projections.get("app-session-1")).toMatchObject({
        lastUserMessageAt: "2026-07-03T10:00:00.000Z",
      });
    },
  );

  it("preserves the persisted initial prompt when snapshots refresh Projection records", async () => {
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
      now: () => "2026-07-03T10:00:00.000Z",
      idFactory: () => "evt-fixed",
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: {
        sessionId: "app-session-1",
        projectId: "pig",
        cwd: "/repo",
      },
    });
    await service.handleRequest({
      id: "req-prompt",
      method: "send_prompt",
      params: {
        piSessionId: "pi-session-1",
        prompt: "Persisted title",
      },
    });
    await service.handleRequest({
      id: "req-snapshot",
      method: "get_runtime_snapshot",
      params: { piSessionId: "pi-session-1" },
    });

    await expect(projections.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "app-session-1",
        initialPrompt: "Persisted title",
      }),
    ]);
  });

  it("accepts the max thinking level on configure_model", async () => {
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "app-session-max", projectId: "pig", cwd: "/repo" },
    });

    await expect(
      service.handleRequest({
        id: "req-configure-max",
        method: "configure_model",
        params: {
          sessionId: "app-session-max",
          piSessionId: "pi-session-1",
          provider: "deepseek",
          modelId: "deepseek-v4-pro",
          thinkingLevel: "max",
        },
      }),
    ).resolves.toMatchObject({
      id: "req-configure-max",
      result: {
        selected: {
          provider: "deepseek",
          modelId: "deepseek-v4-pro",
          thinkingLevel: "max",
        },
      },
    });
  });

  it("persists one validated model pair and restores it on a cold resume", async () => {
    const projections = createInMemorySessionProjectionStore();
    const firstService = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
      now: () => "2026-07-19T10:00:00.000Z",
    });

    await firstService.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "pig", cwd: "/repo" },
    });
    await expect(
      firstService.handleRequest({
        id: "req-configure",
        method: "configure_model",
        params: {
          sessionId: "app-session-1",
          piSessionId: "pi-session-1",
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          thinkingLevel: "high",
        },
      }),
    ).resolves.toMatchObject({
      id: "req-configure",
      result: {
        selected: {
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          thinkingLevel: "high",
        },
      },
    });
    await expect(projections.get("app-session-1")).resolves.toMatchObject({
      modelSelection: {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      },
      // configure_model must not bump list time to "now".
      updatedAt: "2026-06-29T12:00:00.000Z",
    });

    const restartDriver = createFakeRuntimeDriver();
    const resumeSession = vi.spyOn(restartDriver, "resumeSession");
    const restartedService = createRuntimeGatewayService({
      driver: restartDriver,
      projections,
    });

    await restartedService.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId: "app-session-1",
        projectId: "pig",
        piSessionId: "pi-session-1",
        sessionFile: "/sessions/pi-session-1.jsonl",
        cwd: "/repo",
      },
    });

    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          thinkingLevel: "high",
        },
      }),
    );
  });

  it("does not stamp resume wall-clock onto projection list time (DF-012)", async () => {
    const journal = createInMemorySessionEventJournal();
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      journal,
      projections,
      now: () => "2026-08-07T13:30:00.000Z",
    });

    await projections.save({
      sessionId: "app-session-old",
      runtimeId: "runtime:app-session-old",
      piSessionId: "pi-session-old",
      projectId: "pig",
      cwd: "/repo",
      status: "completed",
      sessionFile: "/sessions/pi-session-old.jsonl",
      // Corrupted by an earlier resume that wrote "now".
      updatedAt: "2026-08-07T05:00:00.000Z",
    });

    journal.append({
      id: "evt-old-assistant",
      seq: 3,
      sessionId: "app-session-old",
      piSessionId: "pi-session-old",
      type: "message_update",
      ts: "2026-08-01T12:03:34.764Z",
      payload: {
        kind: "message",
        role: "assistant",
        body: "Real last answer",
      },
    });

    await service.handleRequest({
      id: "req-resume-old",
      method: "resume_session",
      params: {
        sessionId: "app-session-old",
        projectId: "pig",
        piSessionId: "pi-session-old",
        sessionFile: "/sessions/pi-session-old.jsonl",
        cwd: "/repo",
      },
    });

    await expect(projections.get("app-session-old")).resolves.toMatchObject({
      updatedAt: "2026-08-01T12:03:34.764Z",
    });
  });

  it("persists runtime status and usage as driver events arrive", async () => {
    const driver = createFakeRuntimeDriver();
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver,
      projections,
      now: () => "2026-07-18T12:00:00.000Z",
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "pig", cwd: "/repo" },
    });
    await service.handleRequest({
      id: "req-prompt",
      method: "send_prompt",
      params: { piSessionId: "pi-session-1", prompt: "Persist live state" },
    });

    await vi.waitFor(async () => {
      await expect(projections.get("app-session-1")).resolves.toMatchObject({
        status: "running",
        updatedAt: "2026-07-18T12:00:00.000Z",
      });
    });

    driver.emitDriverEvent(
      agentEvent("pi-session-1", {
        type: "usage",
        runId: "run-1",
        summary: {
          provider: "openai",
          model: "gpt-5-codex",
          totalTokens: 128,
          totalCostUsd: 0.0042,
        },
        surface: "hidden",
      }),
    );
    driver.emitDriverEvent(
      agentEvent("pi-session-1", {
        type: "run",
        runId: "run-1",
        phase: "end",
        trigger: "prompt",
        outcome: "completed",
        surface: "hidden",
      }),
    );

    await vi.waitFor(async () => {
      await expect(projections.get("app-session-1")).resolves.toMatchObject({
        status: "completed",
        summary: {
          provider: "openai",
          model: "gpt-5-codex",
          totalTokens: 128,
          totalCostUsd: 0.0042,
        },
      });
    });
  });

  it("archives inactive Sessions and rejects active ones", async () => {
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
      now: () => "2026-07-18T12:00:00.000Z",
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "pig", cwd: "/repo" },
    });
    await service.handleRequest({
      id: "req-prompt",
      method: "send_prompt",
      params: { piSessionId: "pi-session-1", prompt: "Run first" },
    });

    await expect(
      service.handleRequest({
        id: "req-archive-active",
        method: "archive_session",
        params: { sessionId: "app-session-1" },
      }),
    ).resolves.toEqual({
      id: "req-archive-active",
      error: "Cannot archive an active Session.",
    });

    await projections.save({
      ...(await projections.get("app-session-1"))!,
      status: "completed",
    });

    await expect(
      service.handleRequest({
        id: "req-archive",
        method: "archive_session",
        params: { sessionId: "app-session-1" },
      }),
    ).resolves.toEqual({
      id: "req-archive",
      result: expect.objectContaining({
        sessionId: "app-session-1",
        status: "archived",
        archivedAt: "2026-07-18T12:00:00.000Z",
      }),
    });
  });

  it("renames Sessions with a trimmed custom title and rejects blank ones", async () => {
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
      now: () => "2026-07-18T12:00:00.000Z",
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "pig", cwd: "/repo" },
    });

    await expect(
      service.handleRequest({
        id: "req-rename",
        method: "rename_session",
        params: { sessionId: "app-session-1", title: "  Ship the sidebar  " },
      }),
    ).resolves.toEqual({
      id: "req-rename",
      result: expect.objectContaining({
        sessionId: "app-session-1",
        title: "Ship the sidebar",
      }),
    });
    await expect(projections.get("app-session-1")).resolves.toMatchObject({
      title: "Ship the sidebar",
    });

    await expect(
      service.handleRequest({
        id: "req-rename-blank",
        method: "rename_session",
        params: { sessionId: "app-session-1", title: "   " },
      }),
    ).resolves.toEqual({
      id: "req-rename-blank",
      error: "title is required",
    });

    await expect(
      service.handleRequest({
        id: "req-rename-missing",
        method: "rename_session",
        params: { sessionId: "app-session-unknown", title: "Anything" },
      }),
    ).resolves.toEqual({
      id: "req-rename-missing",
      error: 'Session "app-session-unknown" was not found.',
    });
  });

  it("drains a live runtime before deleting its projection", async () => {
    const projections = createInMemorySessionProjectionStore();
    let release!: () => void;
    const drain = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const driver = { ...createFakeRuntimeDriver(), async disposeSession(id: string) {
      expect(id).toBe("pi-session-1"); entered(); await drain;
    } };
    const service = createRuntimeGatewayService({ driver, projections });
    await service.handleRequest({ id: "create", method: "create_session", params: { sessionId: "app", projectId: "p", cwd: "/repo" } });
    const deleting = service.handleRequest({ id: "delete", method: "delete_session", params: { sessionId: "app" } });
    // The implementation must enter disposal before removing the projection.
    await Promise.race([started, deleting]);
    expect(await projections.get("app")).not.toBeNull();
    release();
    expect(await deleting).not.toHaveProperty("error");
    expect(await projections.get("app")).toBeNull();
  });

  it("finishes a queued runtime projection write before removing the Session", async () => {
    const persisted = createInMemorySessionProjectionStore();
    const saving = deferred();
    const finishSave = deferred();
    const operations: string[] = [];
    let holdSave = false;
    const projections = {
      ...persisted,
      async save(projection: Parameters<typeof persisted.save>[0]) {
        if (holdSave) {
          operations.push("save-start");
          saving.resolve();
          await finishSave.promise;
          operations.push("save-end");
        }
        await persisted.save(projection);
      },
      async remove(sessionId: string) {
        operations.push("remove");
        await persisted.remove(sessionId);
      },
    };
    const base = createFakeRuntimeDriver();
    const driver = { ...base, async disposeSession(piSessionId: string) {
      base.emitDriverEvent({ piSessionId, type: "run", payload: { type: "run", phase: "end", outcome: "aborted" } });
      await saving.promise;
    } };
    const service = createRuntimeGatewayService({ driver, projections });
    await service.handleRequest({ id: "create", method: "create_session", params: { sessionId: "app", projectId: "p", cwd: "/repo" } });
    holdSave = true;
    const deleting = service.handleRequest({ id: "delete", method: "delete_session", params: { sessionId: "app" } });
    await saving.promise;
    // Drain already scheduled continuations while the write remains gated.
    await afterMicrotasks();
    finishSave.resolve();
    expect(await deleting).not.toHaveProperty("error");
    expect(operations).toEqual(["save-start", "save-end", "remove"]);
    expect(await persisted.get("app")).toBeNull();
  });

  it("does not recreate a deleted Session when an earlier read-only snapshot returns", async () => {
    const persisted = createInMemorySessionProjectionStore();
    const operations: string[] = [];
    const projections = {
      ...persisted,
      async save(projection: Parameters<typeof persisted.save>[0]) {
        await persisted.save(projection);
        operations.push("save");
      },
      async remove(sessionId: string) {
        operations.push("remove");
        await persisted.remove(sessionId);
      },
    };
    const reading = deferred();
    const finishRead = deferred();
    const base = createFakeRuntimeDriver();
    const disposeSession = vi.fn(async () => {});
    const driver = { ...base, disposeSession, async getSnapshot(piSessionId: string) {
      reading.resolve();
      await finishRead.promise;
      return base.getSnapshot(piSessionId);
    } };
    const service = createRuntimeGatewayService({ driver, projections });
    await service.handleRequest({ id: "create", method: "create_session", params: { sessionId: "app-session-1", projectId: "p", cwd: "/repo" } });
    operations.length = 0;
    const snapshot = service.handleRequest({ id: "snapshot", method: "get_runtime_snapshot", params: { piSessionId: "pi-session-1" } });
    await reading.promise;
    const deleting = service.handleRequest({ id: "delete", method: "delete_session", params: { sessionId: "app-session-1" } });
    await afterMicrotasks();
    const removedDuringRead = operations.includes("remove");
    finishRead.resolve();
    const responses = await Promise.all([snapshot, deleting]);
    expect(responses.every(response => !response.error)).toBe(true);
    expect(removedDuringRead).toBe(true);
    expect(operations).toEqual(["remove"]);
    expect(await projections.get("app-session-1")).toBeNull();
  });

  it("stops a root while its prompt is waiting for an asynchronous input hook", async () => {
    const enteredInput = deferred();
    const finishInput = deferred();
    const base = createFakeRuntimeDriver();
    const stopRun = vi.fn(async (input: Parameters<typeof base.stopRun>[0]) => {
      finishInput.resolve();
      return base.stopRun(input);
    });
    const driver = { ...base, stopRun, async sendPrompt(input: Parameters<typeof base.sendPrompt>[0]) {
      enteredInput.resolve();
      await finishInput.promise;
      return base.sendPrompt(input);
    } };
    const service = createRuntimeGatewayService({ driver, projections: createInMemorySessionProjectionStore() });
    await service.handleRequest({ id: "create", method: "create_session", params: { sessionId: "app", projectId: "p", cwd: "/repo" } });
    const prompting = service.handleRequest({ id: "prompt", method: "send_prompt", params: { piSessionId: "pi-session-1", prompt: "@planner inspect this task" } });
    await enteredInput.promise;
    const stopping = service.handleRequest({ id: "stop", method: "stop_run", params: { piSessionId: "pi-session-1" } });
    await afterMicrotasks();
    const stoppedBeforeInputFinished = stopRun.mock.calls.length > 0;
    // Release the input even on the broken path so the assertion reports a deadlock without hanging.
    finishInput.resolve();
    const responses = await Promise.all([prompting, stopping]);
    expect(responses.every(response => !response.error)).toBe(true);
    expect(stoppedBeforeInputFinished).toBe(true);
    expect(stopRun).toHaveBeenCalledWith({ piSessionId: "pi-session-1" });
  });

  it("cancels a pending input hook before draining its writes and deleting the root", async () => {
    const projections = createInMemorySessionProjectionStore();
    const enteredInput = deferred();
    const finishInput = deferred();
    const base = createFakeRuntimeDriver();
    const disposeSession = vi.fn(async () => { finishInput.resolve(); });
    const driver = { ...base, disposeSession, async sendPrompt(input: Parameters<typeof base.sendPrompt>[0]) {
      enteredInput.resolve();
      await finishInput.promise;
      return base.sendPrompt(input);
    } };
    const service = createRuntimeGatewayService({ driver, projections });
    await service.handleRequest({ id: "create", method: "create_session", params: { sessionId: "app", projectId: "p", cwd: "/repo" } });
    const prompting = service.handleRequest({ id: "prompt", method: "send_prompt", params: { piSessionId: "pi-session-1", prompt: "@planner inspect this task" } });
    await enteredInput.promise;
    const deleting = service.handleRequest({ id: "delete", method: "delete_session", params: { sessionId: "app" } });
    await afterMicrotasks();
    const disposedBeforeInputFinished = disposeSession.mock.calls.length > 0;
    finishInput.resolve();
    const responses = await Promise.all([prompting, deleting]);
    expect(responses.every(response => !response.error)).toBe(true);
    expect(disposedBeforeInputFinished).toBe(true);
    expect(disposeSession).toHaveBeenCalledWith("pi-session-1");
    await service.flush();
    expect(await projections.get("app")).toBeNull();
  });

  it("allows an independent Session request to finish while another root snapshot is pending", async () => {
    const projections = createInMemorySessionProjectionStore();
    const reading = deferred();
    const finishRead = deferred();
    const base = createFakeRuntimeDriver();
    const driver = {
      ...base,
      async createSession(input: Parameters<typeof base.createSession>[0]) {
        return { ...await base.createSession(input), piSessionId: `pi-${input.sessionId}` };
      },
      async getSnapshot(piSessionId: string) {
        if (piSessionId === "pi-a") {
          reading.resolve();
          await finishRead.promise;
        }
        return { ...await base.getSnapshot(piSessionId), sessionId: piSessionId.slice(3) };
      },
    };
    const service = createRuntimeGatewayService({ driver, projections });
    for (const sessionId of ["a", "b"]) await service.handleRequest({ id: `create-${sessionId}`, method: "create_session", params: { sessionId, projectId: "p", cwd: "/repo" } });
    const a = service.handleRequest({ id: "snapshot-a", method: "get_runtime_snapshot", params: { piSessionId: "pi-a" } });
    await reading.promise;
    let otherFinished = false;
    const b = service.handleRequest({ id: "snapshot-b", method: "get_runtime_snapshot", params: { piSessionId: "pi-b" } }).then(response => { otherFinished = true; return response; });
    await afterMicrotasks();
    const finishedIndependently = otherFinished;
    finishRead.resolve();
    const responses = await Promise.all([a, b]);
    expect(responses.every(response => !response.error)).toBe(true);
    expect(finishedIndependently).toBe(true);
  });

  it("deletes inactive Session Projections and rejects active ones", async () => {
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
      now: () => "2026-07-18T12:00:00.000Z",
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "pig", cwd: "/repo" },
    });
    await service.handleRequest({
      id: "req-prompt",
      method: "send_prompt",
      params: { piSessionId: "pi-session-1", prompt: "Run first" },
    });

    await expect(
      service.handleRequest({
        id: "req-delete-active",
        method: "delete_session",
        params: { sessionId: "app-session-1" },
      }),
    ).resolves.toEqual({
      id: "req-delete-active",
      error: "Cannot delete an active Session.",
    });

    await projections.save({
      ...(await projections.get("app-session-1"))!,
      status: "completed",
    });

    await expect(
      service.handleRequest({
        id: "req-delete",
        method: "delete_session",
        params: { sessionId: "app-session-1" },
      }),
    ).resolves.toEqual({
      id: "req-delete",
      result: expect.objectContaining({
        sessionId: "app-session-1",
        status: "completed",
      }),
    });
    await expect(projections.get("app-session-1")).resolves.toBeNull();

    await expect(
      service.handleRequest({
        id: "req-delete-missing",
        method: "delete_session",
        params: { sessionId: "app-session-1" },
      }),
    ).resolves.toEqual({
      id: "req-delete-missing",
      error: 'Session "app-session-1" was not found.',
    });
  });

  it("resumes persisted SDK sessions and restores the gateway session mapping", async () => {
    const journal = createInMemorySessionEventJournal();
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      journal,
      projections,
      now: () => "2026-07-03T12:00:00.000Z",
      idFactory: () => "evt-resumed",
    });

    journal.append({
      id: "evt-old-user",
      seq: 7,
      sessionId: "app-session-resumed",
      piSessionId: "pi-session-resumed",
      type: "message_update",
      ts: "2026-07-03T11:00:00.000Z",
      payload: {
        kind: "message",
        role: "user",
        body: "Existing history",
      },
    });

    const resumeResponse = await service.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId: "app-session-resumed",
        projectId: "pig",
        piSessionId: "pi-session-resumed",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
        cwd: "/repo",
        checkout: {
          mode: "foreground-local",
          root: "/repo",
          runtimeCwd: "/repo",
        },
      },
    });
    const snapshot = resumeResponse.result as {
      events: Array<{ payload: Record<string, unknown> }>;
    };

    expect(resumeResponse).toEqual({
      id: "req-resume",
      result: expect.objectContaining({
        sessionId: "app-session-resumed",
        runtimeId: "runtime:app-session-resumed",
        piSessionId: "pi-session-resumed",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
      }),
    });
    expect(snapshot.events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          body: "Existing history",
        }),
      }),
    ]);
    await expect(projections.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "app-session-resumed",
        runtimeId: "runtime:app-session-resumed",
        piSessionId: "pi-session-resumed",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
        // DF-012: last message ts, not driver resume wall-clock (12:00).
        updatedAt: "2026-07-03T11:00:00.000Z",
      }),
    ]);

    await expect(
      service.handleRequest({
        id: "req-prompt-after-resume",
        method: "send_prompt",
        params: {
          piSessionId: "pi-session-resumed",
          prompt: "Continue after resume",
        },
      }),
    ).resolves.toEqual({
      id: "req-prompt-after-resume",
      result: expect.objectContaining({
        sessionId: "app-session-resumed",
        piSessionId: "pi-session-resumed",
        type: "message_update",
      }),
    });
  });

  it("continues event sequencing after replaying a persisted journal", async () => {
    const journal = createInMemorySessionEventJournal();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      journal,
      now: () => "2026-07-18T12:00:00.000Z",
      idFactory: () => "evt-after-restart",
    });

    journal.append({
      id: "evt-before-restart",
      seq: 41,
      sessionId: "app-session-resumed",
      piSessionId: "pi-session-resumed",
      type: "run",
      ts: "2026-07-18T11:59:00.000Z",
      payload: {
        type: "run",
        runId: "run-before-restart",
        phase: "end",
        trigger: "prompt",
        outcome: "completed",
        surface: "hidden",
        origin: "sdk",
      },
    });

    await service.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId: "app-session-resumed",
        projectId: "pig",
        piSessionId: "pi-session-resumed",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
        cwd: "/repo",
      },
    });

    await expect(
      service.handleRequest({
        id: "req-prompt-after-restart",
        method: "send_prompt",
        params: {
          piSessionId: "pi-session-resumed",
          prompt: "Continue after restart",
        },
      }),
    ).resolves.toEqual({
      id: "req-prompt-after-restart",
      result: expect.objectContaining({
        id: "evt-after-restart",
        seq: 42,
      }),
    });
  });

  it("preserves projection-only fields and terminal status while resuming cold sessions", async () => {
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
      now: () => "2026-07-03T12:00:00.000Z",
      idFactory: () => "evt-resumed",
    });

    await projections.save({
      sessionId: "app-session-resumed",
      runtimeId: "runtime:app-session-resumed",
      piSessionId: "pi-session-resumed",
      projectId: "pig",
      initialPrompt: "Keep this title",
      cwd: "/repo",
      status: "completed",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
      updatedAt: "2026-07-03T11:00:00.000Z",
    });
    await service.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId: "app-session-resumed",
        projectId: "pig",
        piSessionId: "pi-session-resumed",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
        cwd: "/repo",
      },
    });

    await expect(projections.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "app-session-resumed",
        initialPrompt: "Keep this title",
        status: "completed",
      }),
    ]);
  });

  it("forks a persisted SDK session and copies journal history before the selected user message", async () => {
    const journal = createInMemorySessionEventJournal();
    const projections = createInMemorySessionProjectionStore();
    let idCounter = 0;
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      journal,
      projections,
      now: () => "2026-07-03T12:10:00.000Z",
      idFactory: () => `evt-fork-${(idCounter += 1)}`,
    });

    journal.append({
      id: "evt-source-user-1",
      seq: 1,
      sessionId: "app-session-source",
      piSessionId: "pi-session-source",
      type: "message_update",
      ts: "2026-07-03T11:00:00.000Z",
      payload: {
        kind: "message",
        role: "user",
        body: "Earlier user",
        messageId: "pi-sdk:pi-session-source:user:0",
        piEntryId: "pi-entry-user-1",
      },
    });
    journal.append({
      id: "evt-source-run",
      seq: 2,
      sessionId: "app-session-source",
      piSessionId: "pi-session-source",
      type: "run",
      ts: "2026-07-03T11:00:01.000Z",
      payload: {
        type: "run",
        runId: "pi-session-source:run-1",
        phase: "end",
        trigger: "prompt",
        outcome: "completed",
        origin: "sdk",
        surface: "hidden",
      },
    });
    journal.append({
      id: "evt-source-user-2",
      seq: 3,
      sessionId: "app-session-source",
      piSessionId: "pi-session-source",
      type: "message_update",
      ts: "2026-07-03T11:05:00.000Z",
      payload: {
        kind: "message",
        role: "user",
        body: "Revise this branch",
        messageId: "pi-sdk:pi-session-source:user:1",
        piEntryId: "pi-entry-user-2",
      },
    });
    journal.append({
      id: "evt-source-after-fork",
      seq: 4,
      sessionId: "app-session-source",
      piSessionId: "pi-session-source",
      type: "message_update",
      ts: "2026-07-03T11:06:00.000Z",
      payload: {
        kind: "message",
        role: "assistant",
        body: "This answer is after the fork point.",
        messageId: "pi-session-source:run-2:turn-1:msg-1",
      },
    });

    const forkResponse = await service.handleRequest({
      id: "req-fork",
      method: "fork_session",
      params: {
        sessionId: "app-session-forked",
        projectId: "pig",
        sourcePiSessionId: "pi-session-source",
        sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
        piEntryId: "pi-entry-user-2",
        cwd: "/repo-forked",
        checkout: {
          mode: "managed-worktree",
          root: "/repo-forked",
          runtimeCwd: "/repo-forked",
        },
      },
    });

    expect(forkResponse).toEqual({
      id: "req-fork",
      result: {
        selectedText: "Revise this branch",
        snapshot: expect.objectContaining({
          sessionId: "app-session-forked",
          runtimeId: "runtime:app-session-forked",
          piSessionId: "pi-session-forked",
          cwd: "/repo-forked",
          sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
        }),
      },
    });

    await expect(journal.read("pi-session-forked")).resolves.toEqual([
      expect.objectContaining({
        id: "evt-fork-1",
        seq: 1,
        sessionId: "app-session-forked",
        piSessionId: "pi-session-forked",
        payload: expect.objectContaining({
          body: "Earlier user",
          messageId: "pi-sdk:pi-session-forked:user:0",
          piEntryId: "pi-entry-user-1",
        }),
      }),
      expect.objectContaining({
        id: "evt-fork-2",
        seq: 2,
        sessionId: "app-session-forked",
        piSessionId: "pi-session-forked",
        payload: expect.objectContaining({
          runId: "pi-session-forked:run-1",
        }),
      }),
      expect.objectContaining({
        id: "evt-fork-3",
        seq: 3,
        sessionId: "app-session-forked",
        piSessionId: "pi-session-forked",
        type: "fork",
        payload: expect.objectContaining({
          kind: "fork",
          sourcePiSessionId: "pi-session-source",
          sourceSessionId: "app-session-source",
          piEntryId: "pi-entry-user-2",
        }),
      }),
    ]);
    await expect(projections.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "app-session-forked",
        runtimeId: "runtime:app-session-forked",
        piSessionId: "pi-session-forked",
        cwd: "/repo-forked",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
        lastUserMessageAt: "2026-07-03T12:10:00.000Z",
      }),
    ]);
    await expect(
      service.handleRequest({
        id: "req-prompt-after-fork",
        method: "send_prompt",
        params: {
          piSessionId: "pi-session-forked",
          prompt: "Continue fork",
        },
      }),
    ).resolves.toEqual({
      id: "req-prompt-after-fork",
      result: expect.objectContaining({
        sessionId: "app-session-forked",
        piSessionId: "pi-session-forked",
        type: "message_update",
      }),
    });
  });

  it("checks the journal fork point before creating a forked runtime", async () => {
    const journal = createInMemorySessionEventJournal();
    const driver = createFakeRuntimeDriver();
    const forkSession = vi.spyOn(driver, "forkSession");
    const service = createRuntimeGatewayService({
      driver,
      journal,
    });

    journal.append({
      id: "evt-source-user",
      seq: 1,
      sessionId: "app-session-source",
      piSessionId: "pi-session-source",
      type: "message_update",
      ts: "2026-07-03T11:00:00.000Z",
      payload: {
        kind: "message",
        role: "user",
        body: "Earlier user",
        piEntryId: "pi-entry-user-1",
      },
    });

    const response = await service.handleRequest({
      id: "req-fork-missing",
      method: "fork_session",
      params: {
        sessionId: "app-session-forked",
        projectId: "pig",
        sourcePiSessionId: "pi-session-source",
        sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
        piEntryId: "pi-entry-user-missing",
        cwd: "/repo-forked",
      },
    });

    expect(response).toEqual({
      id: "req-fork-missing",
      error:
        'Fork point "pi-entry-user-missing" was not found in the Session Event Journal.',
    });
    expect(forkSession).not.toHaveBeenCalled();
    await expect(journal.read("pi-session-forked")).resolves.toEqual([]);
  });

  it("rewrites only identity fields while preserving copied message text", async () => {
    const journal = createInMemorySessionEventJournal();
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      journal,
      now: () => "2026-07-03T12:10:00.000Z",
      idFactory: () => "evt-fork",
    });

    journal.append({
      id: "evt-source-user-1",
      seq: 1,
      sessionId: "app-session-source",
      piSessionId: "pi-session-source",
      type: "message_update",
      ts: "2026-07-03T11:00:00.000Z",
      payload: {
        kind: "message",
        role: "user",
        body: "Path mentions pi-session-source and must stay literal.",
        messageId: "pi-sdk:pi-session-source:user:0",
        piEntryId: "pi-entry-user-1",
      },
    });
    journal.append({
      id: "evt-source-user-2",
      seq: 2,
      sessionId: "app-session-source",
      piSessionId: "pi-session-source",
      type: "message_update",
      ts: "2026-07-03T11:01:00.000Z",
      payload: {
        kind: "message",
        role: "user",
        body: "Fork from here",
        messageId: "pi-sdk:pi-session-source:user:1",
        piEntryId: "pi-entry-user-2",
      },
    });

    await service.handleRequest({
      id: "req-fork",
      method: "fork_session",
      params: {
        sessionId: "app-session-forked",
        projectId: "pig",
        sourcePiSessionId: "pi-session-source",
        sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
        piEntryId: "pi-entry-user-2",
        cwd: "/repo-forked",
      },
    });

    await expect(journal.read("pi-session-forked")).resolves.toEqual([
      expect.objectContaining({
        ts: "2026-07-03T11:00:00.000Z",
        payload: expect.objectContaining({
          body: "Path mentions pi-session-source and must stay literal.",
          messageId: "pi-sdk:pi-session-forked:user:0",
        }),
      }),
      expect.objectContaining({
        type: "fork",
      }),
    ]);
  });

  it("does not rescan all projections when an initial prompt is already persisted", async () => {
    const projections = createInMemorySessionProjectionStore();
    const list = vi.spyOn(projections, "list");
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      projections,
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: {
        sessionId: "app-session-1",
        projectId: "pig",
        cwd: "/repo",
      },
    });
    await service.handleRequest({
      id: "req-prompt-1",
      method: "send_prompt",
      params: { piSessionId: "pi-session-1", prompt: "First prompt" },
    });
    const listCallsAfterFirstPrompt = list.mock.calls.length;

    await service.handleRequest({
      id: "req-prompt-2",
      method: "send_prompt",
      params: { piSessionId: "pi-session-1", prompt: "Second prompt" },
    });

    expect(list).toHaveBeenCalledTimes(listCallsAfterFirstPrompt);
  });

  it("resolves current-runtime tool schemas by name and omits unregistered tools", async () => {
    const bashSchema = {
      description: "Execute a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    };
    const driver = createFakeRuntimeDriver();
    driver.resolveToolSchemas = async (input) => {
      const schemas: Record<string, typeof bashSchema> = {};

      if (input.names.includes("bash")) {
        schemas.bash = bashSchema;
      }

      return { schemas };
    };
    const service = createRuntimeGatewayService({ driver });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "pig", cwd: "/repo" },
    });

    await expect(
      service.handleRequest({
        id: "req-schemas",
        method: "resolve_tool_schemas",
        params: {
          piSessionId: "pi-session-1",
          names: ["bash", "gone_tool"],
        },
      }),
    ).resolves.toEqual({
      id: "req-schemas",
      result: {
        schemas: {
          bash: bashSchema,
        },
      },
    });
  });

  it("returns no schemas when the driver cannot read a live tool registry", async () => {
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
    });

    await expect(
      service.handleRequest({
        id: "req-schemas",
        method: "resolve_tool_schemas",
        params: {
          piSessionId: "pi-session-1",
          names: ["bash"],
        },
      }),
    ).resolves.toEqual({
      id: "req-schemas",
      result: { schemas: {} },
    });
  });

  it("creates a chat workspace directory for prepare_chat_workspace", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));
    const sessionId = "session-chat-1";
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      dataDir,
    });

    await expect(
      service.handleRequest({
        id: "req-prepare",
        method: "prepare_chat_workspace",
        params: { sessionId },
      }),
    ).resolves.toEqual({
      id: "req-prepare",
      result: { cwd: join(dataDir, "chats", sessionId) },
    });
    expect((await stat(join(dataDir, "chats", sessionId))).isDirectory()).toBe(true);
  });

  it("requires sessionId for prepare_chat_workspace", async () => {
    const service = createRuntimeGatewayService({
      driver: createFakeRuntimeDriver(),
      dataDir: await mkdtemp(join(tmpdir(), "pigui-chats-")),
    });

    await expect(
      service.handleRequest({
        id: "req-missing",
        method: "prepare_chat_workspace",
        params: {},
      }),
    ).resolves.toEqual({
      id: "req-missing",
      error: "sessionId is required",
    });
    await expect(
      service.handleRequest({
        id: "req-blank",
        method: "prepare_chat_workspace",
        params: { sessionId: "   " },
      }),
    ).resolves.toEqual({
      id: "req-blank",
      error: "sessionId is required",
    });
  });

  it("rebuilds a missing chat cwd before resume_session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));
    const sessionId = "session-chat-resume";
    const rebuilt = join(dataDir, "chats", sessionId);
    const driver = createFakeRuntimeDriver();
    const resumeSession = vi.spyOn(driver, "resumeSession");
    const service = createRuntimeGatewayService({ driver, dataDir });

    const response = await service.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId,
        projectId: "chat",
        piSessionId: "pi-session-chat",
        sessionFile: "/sessions/pi-session-chat.jsonl",
        cwd: join(dataDir, "missing-chat-cwd"),
      },
    });

    expect(response.error).toBeUndefined();
    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: rebuilt }),
    );
    expect((await stat(rebuilt)).isDirectory()).toBe(true);
  });

  it("rewrites stale checkout paths when resume_session rebuilds a missing chat cwd", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));
    const sessionId = "session-chat-resume-checkout";
    const rebuilt = join(dataDir, "chats", sessionId);
    const stale = join(dataDir, "missing-chat-cwd");
    const staleCheckout = {
      mode: "foreground-local",
      root: stale,
      runtimeCwd: stale,
      diffRoot: stale,
      repoRoot: stale,
      projectRoot: stale,
      executionCheckoutRoot: stale,
    };
    const driver = createFakeRuntimeDriver();
    const resumeSession = vi.spyOn(driver, "resumeSession");
    const service = createRuntimeGatewayService({ driver, dataDir });

    const response = await service.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId,
        projectId: "chat",
        piSessionId: "pi-session-chat",
        sessionFile: "/sessions/pi-session-chat.jsonl",
        cwd: stale,
        checkout: staleCheckout,
      },
    });

    expect(response.error).toBeUndefined();
    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: rebuilt,
        checkout: {
          mode: "foreground-local",
          root: rebuilt,
          runtimeCwd: rebuilt,
          diffRoot: rebuilt,
          repoRoot: rebuilt,
          projectRoot: rebuilt,
          executionCheckoutRoot: rebuilt,
        },
      }),
    );
  });

  it("rebuilds a missing chat cwd for the new session on fork_session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));
    const sessionId = "session-chat-fork";
    const rebuilt = join(dataDir, "chats", sessionId);
    const driver = createFakeRuntimeDriver();
    const forkSession = vi.spyOn(driver, "forkSession");
    const service = createRuntimeGatewayService({ driver, dataDir });

    const response = await service.handleRequest({
      id: "req-fork",
      method: "fork_session",
      params: {
        sessionId,
        projectId: "chat",
        sourcePiSessionId: "pi-session-source",
        sourceSessionFile: "/sessions/pi-session-source.jsonl",
        piEntryId: "pi-entry-1",
        cwd: join(dataDir, "missing-fork-cwd"),
      },
    });

    expect(response.error).toBeUndefined();
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: rebuilt }),
    );
    expect((await stat(rebuilt)).isDirectory()).toBe(true);
  });

  it("rewrites stale checkout paths when fork_session rebuilds a missing chat cwd", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));
    const sessionId = "session-chat-fork-checkout";
    const rebuilt = join(dataDir, "chats", sessionId);
    const stale = join(dataDir, "missing-fork-cwd");
    const staleCheckout = {
      mode: "foreground-local",
      root: stale,
      runtimeCwd: stale,
      diffRoot: stale,
      repoRoot: stale,
      projectRoot: stale,
      executionCheckoutRoot: stale,
    };
    const driver = createFakeRuntimeDriver();
    const forkSession = vi.spyOn(driver, "forkSession");
    const service = createRuntimeGatewayService({ driver, dataDir });

    const response = await service.handleRequest({
      id: "req-fork",
      method: "fork_session",
      params: {
        sessionId,
        projectId: "chat",
        sourcePiSessionId: "pi-session-source",
        sourceSessionFile: "/sessions/pi-session-source.jsonl",
        piEntryId: "pi-entry-1",
        cwd: stale,
        checkout: staleCheckout,
      },
    });

    expect(response.error).toBeUndefined();
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: rebuilt,
        checkout: {
          mode: "foreground-local",
          root: rebuilt,
          runtimeCwd: rebuilt,
          diffRoot: rebuilt,
          repoRoot: rebuilt,
          projectRoot: rebuilt,
          executionCheckoutRoot: rebuilt,
        },
      }),
    );
  });

  it("does not replace an existing chat cwd on resume_session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));
    const existing = join(dataDir, "still-here");
    await mkdir(existing);
    const driver = createFakeRuntimeDriver();
    const resumeSession = vi.spyOn(driver, "resumeSession");
    const service = createRuntimeGatewayService({ driver, dataDir });

    await service.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId: "session-chat-existing",
        projectId: "chat",
        piSessionId: "pi-session-chat",
        sessionFile: "/sessions/pi-session-chat.jsonl",
        cwd: existing,
      },
    });

    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: existing }),
    );
  });

  it("does not rewrite checkout paths when the chat cwd still exists on resume_session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));
    const existing = join(dataDir, "still-here");
    await mkdir(existing);
    const checkout = {
      mode: "foreground-local",
      root: existing,
      runtimeCwd: existing,
      diffRoot: join(dataDir, "other-diff"),
      repoRoot: existing,
      projectRoot: existing,
      executionCheckoutRoot: existing,
    };
    const driver = createFakeRuntimeDriver();
    const resumeSession = vi.spyOn(driver, "resumeSession");
    const service = createRuntimeGatewayService({ driver, dataDir });

    await service.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId: "session-chat-existing-checkout",
        projectId: "chat",
        piSessionId: "pi-session-chat",
        sessionFile: "/sessions/pi-session-chat.jsonl",
        cwd: existing,
        checkout,
      },
    });

    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existing,
        checkout,
      }),
    );
  });

  it("does not rebuild a missing cwd for non-chat resume_session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));
    const missing = join(dataDir, "gone-project");
    const driver = createFakeRuntimeDriver();
    const resumeSession = vi.spyOn(driver, "resumeSession");
    const service = createRuntimeGatewayService({ driver, dataDir });

    await service.handleRequest({
      id: "req-resume",
      method: "resume_session",
      params: {
        sessionId: "session-project",
        projectId: "pig",
        piSessionId: "pi-session-project",
        sessionFile: "/sessions/pi-session-project.jsonl",
        cwd: missing,
      },
    });

    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: missing }),
    );
    await expect(stat(join(dataDir, "chats", "session-project"))).rejects.toThrow();
  });
});

it("persists plugin names without replacing manual titles or changing activity time", async () => {
  const driver = createFakeRuntimeDriver();
  const projections = createInMemorySessionProjectionStore();
  const gateway = createRuntimeGatewayService({ driver, projections });
  await gateway.handleRequest({ id: "create", method: "create_session", params: { sessionId: "named", projectId: "p", cwd: "/repo" } });
  const before = (await projections.get("named"))!;
  await projections.save({ ...before, title: "Manual title" });
  driver.emitDriverEvent({ piSessionId: "pi-session-1", type: "session_info_changed", payload: { type: "session_info_changed", name: "Auto title", surface: "hidden" } });
  await gateway.handleRequest({ id: "flush", method: "list_session_projections", params: {} });
  expect(await projections.get("named")).toMatchObject({ title: "Manual title", sessionName: "Auto title", updatedAt: before.updatedAt });
});

describe("send_subagent / stop_subagent", () => {
  function childRecord(overrides: Record<string, unknown> = {}) {
    return {
      childSessionId: "child-1",
      parentSessionId: "pi-session-1",
      ownerToolCallId: "call-agent",
      state: "started",
      source: "tintinweb",
      createdAt: "2026-09-15T12:00:00.000Z",
      updatedAt: "2026-09-15T12:00:00.000Z",
      sourceAgentId: "ag-1",
      capabilities: { send: true, stop: true },
      ...overrides,
    };
  }

  async function liveGateway() {
    const base = createFakeRuntimeDriver();
    const sendSubagent = vi.fn(async () => ({ ok: true as const }));
    const stopSubagent = vi.fn(async () => ({ ok: true as const }));
    const stopRun = vi.spyOn(base, "stopRun");
    const driver = { ...base, sendSubagent, stopSubagent };
    const journal = createInMemorySessionEventJournal();
    const projections = createInMemorySessionProjectionStore();
    const service = createRuntimeGatewayService({ driver, journal, projections });
    await service.handleRequest({
      id: "create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "p", cwd: "/repo" },
    });
    return { service, driver, sendSubagent, stopSubagent, stopRun };
  }

  it("routes send and stop to the driver when the record advertised the control", async () => {
    const { service, driver, sendSubagent, stopSubagent } = await liveGateway();
    driver.emitDriverEvent({
      piSessionId: "pi-session-1",
      type: "subagent",
      payload: { type: "subagent", phase: "start", record: childRecord(), surface: "hidden", origin: "sdk" },
    });

    await expect(
      service.handleRequest({
        id: "send",
        method: "send_subagent",
        params: { sessionId: "pi-session-1", sourceAgentId: "ag-1", text: "nudge" },
      }),
    ).resolves.toMatchObject({ result: { ok: true } });
    await expect(
      service.handleRequest({
        id: "stop",
        method: "stop_subagent",
        params: { piSessionId: "pi-session-1", childSessionId: "child-1" },
      }),
    ).resolves.toMatchObject({ result: { ok: true } });

    expect(sendSubagent).toHaveBeenCalledWith({
      piSessionId: "pi-session-1",
      sourceAgentId: "ag-1",
      text: "nudge",
    });
    expect(stopSubagent).toHaveBeenCalledWith({
      piSessionId: "pi-session-1",
      childSessionId: "child-1",
    });
  });

  it("rejects send/stop when the source did not advertise the control", async () => {
    const { service, driver, sendSubagent, stopSubagent } = await liveGateway();
    driver.emitDriverEvent({
      piSessionId: "pi-session-1",
      type: "subagent",
      payload: {
        type: "subagent",
        phase: "start",
        record: childRecord({ capabilities: {} }),
        surface: "hidden",
        origin: "sdk",
      },
    });

    await expect(
      service.handleRequest({
        id: "send",
        method: "send_subagent",
        params: { piSessionId: "pi-session-1", sourceAgentId: "ag-1", text: "nudge" },
      }),
    ).resolves.toMatchObject({ error: "This subagent does not advertise send." });
    await expect(
      service.handleRequest({
        id: "stop",
        method: "stop_subagent",
        params: { piSessionId: "pi-session-1", sourceAgentId: "ag-1" },
      }),
    ).resolves.toMatchObject({ error: "This subagent does not advertise stop." });
    expect(sendSubagent).not.toHaveBeenCalled();
    expect(stopSubagent).not.toHaveBeenCalled();
  });

  it("rejects missing child identity, unknown child, and missing driver methods", async () => {
    const driver = createFakeRuntimeDriver();
    const service = createRuntimeGatewayService({ driver });
    await service.handleRequest({
      id: "create",
      method: "create_session",
      params: { sessionId: "app-session-1", projectId: "p", cwd: "/repo" },
    });

    await expect(
      service.handleRequest({
        id: "send",
        method: "send_subagent",
        params: { piSessionId: "pi-session-1", text: "nudge" },
      }),
    ).resolves.toMatchObject({ error: "childSessionId or sourceAgentId is required" });
    await expect(
      service.handleRequest({
        id: "send-unknown",
        method: "send_subagent",
        params: { piSessionId: "pi-session-1", sourceAgentId: "ag-1", text: "nudge" },
      }),
    ).resolves.toMatchObject({ error: 'Subagent "ag-1" was not found for this session.' });

    driver.emitDriverEvent({
      piSessionId: "pi-session-1",
      type: "subagent",
      payload: { type: "subagent", phase: "start", record: childRecord(), surface: "hidden", origin: "sdk" },
    });
    await expect(
      service.handleRequest({
        id: "send-ok-ids",
        method: "send_subagent",
        params: { piSessionId: "pi-session-1", sourceAgentId: "ag-1", text: "nudge" },
      }),
    ).resolves.toMatchObject({ error: 'Runtime driver does not support "send_subagent".' });
  });

  it("leaves parent stop_run on the parent abort path", async () => {
    const { service, stopRun, stopSubagent } = await liveGateway();
    const response = await service.handleRequest({
      id: "parent-stop",
      method: "stop_run",
      params: { piSessionId: "pi-session-1" },
    });
    expect(response.error).toBeUndefined();
    expect(stopRun).toHaveBeenCalledWith({ piSessionId: "pi-session-1" });
    expect(stopSubagent).not.toHaveBeenCalled();
  });
});

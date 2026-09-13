import { execFileSync } from "node:child_process";
import { realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackendService } from "./service";
import {
  createInMemorySessionEventJournal,
  resolveDataDir,
} from "./persistence/session-event-journal";
import { createInMemorySessionProjectionStore } from "./persistence/session-projection-store";
import { createFakePiRpcTransport } from "@pace/core/testing";
import type { SessionSummary } from "@pace/core";
import type { PiRuntimeDriver } from "./gateway/runtime-gateway";
import type {
  TerminalManager,
  TerminalManagerEvent,
} from "./drivers/terminal";

const createAgentSession = vi.hoisted(() => vi.fn());
const sessionManagerOpen = vi.hoisted(() => vi.fn());
const sessionManagerListAll = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession,
  SessionManager: {
    open: sessionManagerOpen,
    listAll: sessionManagerListAll,
  },
  AuthStorage: {
    create: () => ({
      get: () => null,
      set: () => undefined,
      delete: () => undefined,
    }),
  },
  ModelRegistry: {
    create: () => ({
      getAvailable: () => [],
    }),
  },
}));

function fixtureAgentDir() {
  return join(process.cwd(), "fixtures/pi-agent");
}

function createFakeSdkAgentSession() {
  const listeners: Array<(event: unknown) => void> = [];
  let resolvePrompt: (() => void) | undefined;
  const session = {
    sessionId: "pi-session-sdk",
    isStreaming: false,
    messages: [],
    model: {
      provider: { id: "openai" },
      id: "gpt-5-codex",
    },
    sessionManager: undefined as
      | {
          getCwd?(): string;
          getSessionFile?(): string;
        }
      | undefined,
    prompt: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
    ),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);

      return vi.fn();
    }),
    getSessionStats: vi.fn(() => ({
      tokens: { total: 42 },
      cost: 0.001,
    })),
  };

  return {
    session,
    emit(event: unknown) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    resolvePrompt() {
      resolvePrompt?.();
    },
  };
}

const tempDirs: string[] = [];

function createFakeTerminalManager() {
  const created: Array<{
    sessionId: string;
    piSessionId: string;
    cwd: string;
    cols: number;
    rows: number;
  }> = [];
  let listener: ((event: TerminalManagerEvent) => void) | undefined;
  const write = vi.fn();
  const resize = vi.fn();
  const close = vi.fn();
  const manager: TerminalManager = {
    create: async (input) => {
      created.push(input);

      return {
        terminalId: "term-fake-1",
        sessionId: input.sessionId,
        cwd: input.cwd,
        status: "running",
      };
    },
    list: () => [],
    attach: () => ({ scrollback: "replay", end: 6 }),
    write,
    resize,
    close,
    onEvent: (next) => {
      listener = next;

      return () => {};
    },
    disposeAll: () => {},
  };

  return {
    manager,
    created,
    write,
    resize,
    close,
    emit(event: TerminalManagerEvent) {
      listener?.(event);
    },
  };
}

async function tempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "pigui-service-"));

  tempDirs.push(dir);

  return dir;
}

describe("backend service", () => {
  beforeEach(async () => {
    vi.stubEnv("PACE_DATA_DIR", await tempDataDir());
    createAgentSession.mockReset();
    sessionManagerOpen.mockReset();
    sessionManagerListAll.mockReset();
    sessionManagerListAll.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("routes model configuration through the Runtime Gateway", async () => {
    const projections = createInMemorySessionProjectionStore();
    const configureModel = vi.fn(async () => ({
      models: [
        {
          provider: "anthropic",
          modelId: "claude-haiku-4",
          name: "Claude Haiku 4",
          thinkingLevels: ["off" as const, "low" as const],
        },
      ],
      selected: {
        provider: "anthropic",
        modelId: "claude-haiku-4",
        thinkingLevel: "low" as const,
      },
    }));
    const runtimeDriver = {
      configureModel,
      onEvent: vi.fn(() => () => {}),
    } as unknown as PiRuntimeDriver;

    await projections.save({
      sessionId: "session-controls",
      runtimeId: "runtime-controls",
      piSessionId: "pi-session-controls",
      projectId: "project-1",
      cwd: process.cwd(),
      status: "idle",
      updatedAt: "2026-07-19T00:00:00.000Z",
    });

    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      runtimeDriver,
      runtimeJournal: createInMemorySessionEventJournal(),
      sessionProjectionStore: projections,
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-configure-model",
        method: "configure_model",
        params: {
          sessionId: "session-controls",
          piSessionId: "pi-session-controls",
          provider: "anthropic",
          modelId: "claude-haiku-4",
          thinkingLevel: "low",
        },
      }),
    ).resolves.toEqual({
      id: "req-configure-model",
      result: expect.objectContaining({
        selected: {
          provider: "anthropic",
          modelId: "claude-haiku-4",
          thinkingLevel: "low",
        },
      }),
    });
    expect(configureModel).toHaveBeenCalledWith({
      piSessionId: "pi-session-controls",
      provider: "anthropic",
      modelId: "claude-haiku-4",
      thinkingLevel: "low",
    });
    await expect(projections.get("session-controls")).resolves.toMatchObject({
      modelSelection: {
        provider: "anthropic",
        modelId: "claude-haiku-4",
        thinkingLevel: "low",
      },
    });
  });

  it("routes tool schema resolution through the Runtime Gateway", async () => {
    const bashSchema = {
      description: "Execute a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    };
    const resolveToolSchemas = vi.fn(async () => ({
      schemas: { bash: bashSchema },
    }));
    const runtimeDriver = {
      resolveToolSchemas,
      onEvent: vi.fn(() => () => {}),
    } as unknown as PiRuntimeDriver;
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      runtimeDriver,
      runtimeJournal: createInMemorySessionEventJournal(),
      sessionProjectionStore: createInMemorySessionProjectionStore(),
      piRpc: createFakePiRpcTransport(),
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
      result: { schemas: { bash: bashSchema } },
    });
    expect(resolveToolSchemas).toHaveBeenCalledWith({
      piSessionId: "pi-session-1",
      names: ["bash", "gone_tool"],
    });
  });

  it("handles query commands through request/response envelopes", async () => {
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      gitClient: {
        isGitRepository: async () => true,
        addDetachedWorktree: async () => {},
      },
      piRpc: createFakePiRpcTransport(),
    });

    await expect(service.handleRequest({ id: "req-1", method: "list_sessions" })).resolves.toEqual({
      id: "req-1",
      result: expect.arrayContaining([
        expect.objectContaining({
          id: "newest-session",
          project: "gamma",
        }),
      ]),
    });
    await expect(
      service.handleRequest({
        id: "req-2",
        method: "get_session_detail",
        params: { id: "middle-session" },
      }),
    ).resolves.toEqual({
      id: "req-2",
      result: expect.objectContaining({
        id: "middle-session",
        turns: expect.any(Array),
      }),
    });
    await expect(service.handleRequest({ id: "req-3", method: "get_config_inventory" })).resolves.toEqual({
      id: "req-3",
      result: expect.objectContaining({
        defaultModel: "gpt-5-codex",
      }),
    });
  });

  it("re-derives list_sessions presence from the projection store on every call", async () => {
    const projections = createInMemorySessionProjectionStore();
    const projection = {
      sessionId: "session-newest",
      runtimeId: "runtime-newest",
      piSessionId: "newest-session",
      projectId: "project-1",
      cwd: "/checkout/project",
      status: "completed" as const,
      updatedAt: "2026-08-27T10:00:00.000Z",
    };
    await projections.save(projection);

    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      piRpc: createFakePiRpcTransport(),
    });

    const presenceById = async (id: string) => {
      const response = await service.handleRequest({ id, method: "list_sessions" });
      const sessions = response.result as SessionSummary[];

      return Object.fromEntries(
        sessions.map((session) => [session.id, session.presence]),
      );
    };

    expect(await presenceById("req-presence-1")).toEqual({
      "newest-session": "active",
      "middle-session": "external",
      "oldest-session": "external",
    });

    // The summary index is cached by file mtime; presence must still follow the
    // projection store, which changed without any session file changing.
    await projections.save({
      ...projection,
      status: "archived",
      archivedAt: "2026-08-27T11:00:00.000Z",
      updatedAt: "2026-08-27T11:00:00.000Z",
    });

    expect(await presenceById("req-presence-2")).toEqual({
      "newest-session": "archived",
      "middle-session": "external",
      "oldest-session": "external",
    });
  });

  it("resolves Session diff roots from the persisted projection", async () => {
    const projections = createInMemorySessionProjectionStore();
    const read = vi.fn(async (input) => ({
      sessionId: input.sessionId,
      state: "clean" as const,
      checkoutRoot: input.checkoutRoot,
      repositoryRoot: input.checkoutRoot,
      generatedAt: "2026-07-19T00:00:00.000Z",
      files: [],
      totals: {
        files: 0,
        additions: 0,
        deletions: 0,
        binaryFiles: 0,
        conflictedFiles: 0,
      },
      truncated: false,
      omittedFileCount: 0,
    }));

    await projections.save({
      sessionId: "session-changes",
      runtimeId: "runtime-changes",
      piSessionId: "pi-changes",
      projectId: "project-1",
      cwd: "/checkout/project",
      status: "completed",
      checkout: {
        root: "/source/repo",
        executionCheckoutRoot: "/checkout",
        diffRoot: "/checkout/project",
      },
      updatedAt: "2026-07-19T00:00:00.000Z",
    });

    const service = createBackendService({
      sessionProjectionStore: projections,
      sessionChangesReader: { read, checkoutBranch: vi.fn() },
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-changes",
        method: "get_session_changes",
        params: {
          sessionId: "session-changes",
          checkoutRoot: "/renderer/cannot/override/this",
        },
      }),
    ).resolves.toEqual({
      id: "req-changes",
      result: expect.objectContaining({ state: "clean" }),
    });
    expect(read).toHaveBeenCalledWith({
      sessionId: "session-changes",
      checkoutRoot: "/checkout",
      diffRoot: "/checkout/project",
    });
  });

  it("checks out a Session branch from the stored checkout, not renderer paths", async () => {
    const projections = createInMemorySessionProjectionStore();
    const checkoutBranch = vi.fn(async () => ({
      sessionId: "session-changes",
      state: "clean" as const,
      checkoutRoot: "/checkout",
      repositoryRoot: "/checkout",
      generatedAt: "2026-09-05T00:00:00.000Z",
      head: { oid: "abc", branch: "feat/composer-git", detached: false },
      branches: ["feat/composer-git", "main"],
      files: [],
      totals: {
        files: 0,
        additions: 0,
        deletions: 0,
        binaryFiles: 0,
        conflictedFiles: 0,
      },
      truncated: false,
      omittedFileCount: 0,
    }));
    await projections.save({
      sessionId: "session-changes",
      runtimeId: "runtime-changes",
      piSessionId: "pi-changes",
      projectId: "project-1",
      cwd: "/checkout/project",
      status: "completed",
      checkout: {
        root: "/source/repo",
        executionCheckoutRoot: "/checkout",
        diffRoot: "/checkout/project",
      },
      updatedAt: "2026-07-19T00:00:00.000Z",
    });

    const service = createBackendService({
      sessionProjectionStore: projections,
      sessionChangesReader: { read: vi.fn(), checkoutBranch },
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-checkout-branch",
        method: "checkout_session_branch",
        params: {
          sessionId: "session-changes",
          branch: "feat/composer-git",
          checkoutRoot: "/renderer/cannot/override/this",
        },
      }),
    ).resolves.toEqual({
      id: "req-checkout-branch",
      result: expect.objectContaining({
        head: expect.objectContaining({ branch: "feat/composer-git" }),
      }),
    });
    expect(checkoutBranch).toHaveBeenCalledWith({
      sessionId: "session-changes",
      checkoutRoot: "/checkout",
      diffRoot: "/checkout/project",
      branch: "feat/composer-git",
    });
  });

  it("lists a Session directory under the stored diff root, not renderer paths", async () => {
    const projections = createInMemorySessionProjectionStore();
    const listDirectory = vi.fn(async () => ({
      sessionId: "session-files",
      path: "src",
      rootName: "project",
      entries: [],
      truncated: false,
    }));
    await projections.save({
      sessionId: "session-files",
      runtimeId: "runtime-files",
      piSessionId: "pi-files",
      projectId: "project-1",
      cwd: "/checkout/project",
      status: "completed",
      checkout: {
        root: "/source/repo",
        executionCheckoutRoot: "/checkout",
        diffRoot: "/checkout/project",
      },
      updatedAt: "2026-07-19T00:00:00.000Z",
    });

    const service = createBackendService({
      sessionProjectionStore: projections,
      sessionFilesReader: { listDirectory, readFile: vi.fn() },
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-list-dir",
        method: "list_session_directory",
        params: {
          sessionId: "session-files",
          path: "src",
          diffRoot: "/renderer/cannot/override/this",
        },
      }),
    ).resolves.toEqual({
      id: "req-list-dir",
      result: expect.objectContaining({ path: "src", rootName: "project" }),
    });
    expect(listDirectory).toHaveBeenCalledWith({
      sessionId: "session-files",
      diffRoot: "/checkout/project",
      path: "src",
    });

    // A missing path lists the diff root itself.
    await service.handleRequest({
      id: "req-list-root",
      method: "list_session_directory",
      params: { sessionId: "session-files" },
    });
    expect(listDirectory).toHaveBeenLastCalledWith({
      sessionId: "session-files",
      diffRoot: "/checkout/project",
      path: "",
    });
  });

  it("reads a Session file under the stored diff root, not renderer paths", async () => {
    const projections = createInMemorySessionProjectionStore();
    const readSessionFile = vi.fn(async () => ({
      sessionId: "session-files",
      path: "src/app.ts",
      size: 3,
      content: "abc",
      truncated: false,
      binary: false,
    }));
    await projections.save({
      sessionId: "session-files",
      runtimeId: "runtime-files",
      piSessionId: "pi-files",
      projectId: "project-1",
      cwd: "/checkout/project",
      status: "completed",
      checkout: {
        root: "/source/repo",
        executionCheckoutRoot: "/checkout",
        diffRoot: "/checkout/project",
      },
      updatedAt: "2026-07-19T00:00:00.000Z",
    });

    const service = createBackendService({
      sessionProjectionStore: projections,
      sessionFilesReader: { listDirectory: vi.fn(), readFile: readSessionFile },
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-read-file",
        method: "read_session_file",
        params: {
          sessionId: "session-files",
          path: "src/app.ts",
          diffRoot: "/renderer/cannot/override/this",
        },
      }),
    ).resolves.toEqual({
      id: "req-read-file",
      result: expect.objectContaining({ content: "abc" }),
    });
    expect(readSessionFile).toHaveBeenCalledWith({
      sessionId: "session-files",
      diffRoot: "/checkout/project",
      path: "src/app.ts",
    });

    await expect(
      service.handleRequest({
        id: "req-read-file-missing-path",
        method: "read_session_file",
        params: { sessionId: "session-files" },
      }),
    ).resolves.toMatchObject({ error: expect.stringMatching(/path/) });
  });

  it("journals boundary events to the data dir and serves them from the runtime snapshot", async () => {
    const sdkSession = createFakeSdkAgentSession();
    createAgentSession.mockResolvedValue({ session: sdkSession.session });
    const dataDir = await tempDataDir();
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      dataDir,
      piRpc: createFakePiRpcTransport(),
    });

    await service.handleRequest({
      id: "req-create",
      method: "create_session",
      params: { sessionId: "session-1", projectId: "project-1", cwd: process.cwd() },
    });
    const sendResponse = service.handleRequest({
      id: "req-send",
      method: "send_prompt",
      params: { piSessionId: "pi-session-sdk", prompt: "Hello Pi" },
    });
    sdkSession.emit({
      type: "message_end",
      message: { role: "user", content: "Hello Pi" },
    });
    await sendResponse;

    const streamingMessage = { role: "assistant", content: [] };

    sdkSession.emit({ type: "agent_start" });
    sdkSession.emit({ type: "turn_start" });
    sdkSession.emit({ type: "message_start", message: streamingMessage });
    sdkSession.emit({
      type: "message_update",
      message: streamingMessage,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: streamingMessage },
    });
    sdkSession.emit({
      type: "message_update",
      message: streamingMessage,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hi from",
        partial: streamingMessage,
      },
    });
    sdkSession.emit({
      type: "message_update",
      message: streamingMessage,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Hi from SDK",
        partial: streamingMessage,
      },
    });
    sdkSession.emit({ type: "message_end", message: streamingMessage });
    sdkSession.emit({ type: "turn_end" });
    sdkSession.emit({ type: "agent_end" });
    sdkSession.resolvePrompt();

    const response = await service.handleRequest({
      id: "req-snapshot",
      method: "get_runtime_snapshot",
      params: { piSessionId: "pi-session-sdk" },
    });
    const snapshot = response.result as {
      events: Array<{ seq: number; payload: Record<string, unknown> }>;
    };

    expect(snapshot.events[0]?.payload).toEqual(
      expect.objectContaining({ role: "user", body: "Hello Pi" }),
    );
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "message_part",
          phase: "end",
          body: "Hi from SDK",
        }),
      }),
    );
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "run",
          phase: "end",
          outcome: "completed",
        }),
      }),
    );
    expect(
      snapshot.events.some(
        (event) =>
          event.payload.type === "message_part" && event.payload.phase === "update",
      ),
    ).toBe(false);

    const journalLines = (
      await readFile(join(dataDir, "sessions", "pi-session-sdk.jsonl"), "utf8")
    )
      .trim()
      .split("\n");

    expect(journalLines).toHaveLength(snapshot.events.length);

    await expect(
      service.handleRequest({
        id: "req-projections",
        method: "list_session_projections",
      }),
    ).resolves.toEqual({
      id: "req-projections",
      result: [
        expect.objectContaining({
          sessionId: "session-1",
          status: "completed",
          summary: expect.objectContaining({
            totalTokens: 42,
            totalCostUsd: 0.001,
          }),
        }),
      ],
    });

    await expect(
      service.handleRequest({
        id: "req-archive",
        method: "archive_session",
        params: { sessionId: "session-1" },
      }),
    ).resolves.toEqual({
      id: "req-archive",
      result: expect.objectContaining({
        sessionId: "session-1",
        status: "archived",
        archivedAt: expect.any(String),
      }),
    });

    await expect(
      service.handleRequest({
        id: "req-rename",
        method: "rename_session",
        params: { sessionId: "session-1", title: "Journaling spike" },
      }),
    ).resolves.toEqual({
      id: "req-rename",
      result: expect.objectContaining({
        sessionId: "session-1",
        title: "Journaling spike",
      }),
    });

    await expect(
      service.handleRequest({
        id: "req-delete",
        method: "delete_session",
        params: { sessionId: "session-1" },
      }),
    ).resolves.toEqual({
      id: "req-delete",
      result: expect.objectContaining({ sessionId: "session-1" }),
    });

    await expect(
      service.handleRequest({
        id: "req-projections-after-delete",
        method: "list_session_projections",
      }),
    ).resolves.toEqual({ id: "req-projections-after-delete", result: [] });
  });

  it("uses the SDK driver for Runtime Gateway by default while retaining raw RPC commands", async () => {
    const sdkSession = createFakeSdkAgentSession();
    const piRpc = createFakePiRpcTransport();
    createAgentSession.mockResolvedValue({ session: sdkSession.session });
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      // In-memory journal: this test never reads the snapshot back, so a file
      // journal's in-flight append would race the temp-dir cleanup.
      runtimeJournal: createInMemorySessionEventJournal(),
      piRpc,
    });
    const events: unknown[] = [];

    service.onEvent((event) => {
      events.push(event);
    });

    await expect(
      service.handleRequest({
        id: "req-create",
        method: "create_session",
        params: {
          sessionId: "session-1",
          projectId: "project-1",
          cwd: process.cwd(),
        },
      }),
    ).resolves.toEqual({
      id: "req-create",
      result: expect.objectContaining({
        sessionId: "session-1",
        runtimeId: "pi-sdk:session-1",
        piSessionId: "pi-session-sdk",
      }),
    });
    expect(createAgentSession).toHaveBeenCalledWith({
      cwd: process.cwd(),
    });
    expect(piRpc.startCalls).toEqual([]);
    expect(piRpc.commands).toEqual([]);

    const sendResponse = service.handleRequest({
      id: "req-send",
      method: "send_prompt",
      params: {
        piSessionId: "pi-session-sdk",
        prompt: "Hello Pi",
      },
    });
    sdkSession.emit({
      type: "message_end",
      message: { role: "user", content: "Hello Pi" },
    });

    await expect(sendResponse).resolves.toEqual({
      id: "req-send",
      result: expect.objectContaining({
        seq: 1,
        sessionId: "session-1",
        piSessionId: "pi-session-sdk",
        type: "message_update",
        payload: expect.objectContaining({
          role: "user",
          body: "Hello Pi",
        }),
      }),
    });
    expect(sdkSession.session.prompt).toHaveBeenCalledWith("Hello Pi");

    const streamingMessage = { role: "assistant", content: [] };

    sdkSession.emit({ type: "agent_start" });
    sdkSession.emit({ type: "turn_start" });
    sdkSession.emit({ type: "message_start", message: streamingMessage });
    sdkSession.emit({
      type: "message_update",
      message: streamingMessage,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: streamingMessage },
    });
    sdkSession.emit({
      type: "message_update",
      message: streamingMessage,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Hi from SDK",
        partial: streamingMessage,
      },
    });
    sdkSession.resolvePrompt();

    // The user echo stays a Gateway-minted legacy envelope; SDK stream events
    // arrive as Agent Runtime Event Model payloads (ADR-0020).
    expect(events[0]).toEqual({
      type: "event",
      event: expect.objectContaining({
        seq: 1,
        sessionId: "session-1",
        piSessionId: "pi-session-sdk",
        type: "message_update",
        payload: expect.objectContaining({
          role: "user",
          body: "Hello Pi",
        }),
      }),
    });
    expect(events).toContainEqual({
      type: "event",
      event: expect.objectContaining({
        sessionId: "session-1",
        piSessionId: "pi-session-sdk",
        type: "message_part",
        payload: expect.objectContaining({
          type: "message_part",
          partType: "text",
          body: "Hi from SDK",
          surface: "chat",
          origin: "sdk",
        }),
      }),
    });
    await expect(
      service.handleRequest({
        id: "req-rpc",
        method: "send_pi_rpc_command",
        params: {
          command: {
            id: "legacy-rpc-1",
            type: "get_state",
          },
        },
      }),
    ).resolves.toEqual({
      id: "req-rpc",
      result: expect.objectContaining({
        command: "get_state",
        success: true,
      }),
    });
    expect(piRpc.commands).toEqual([
      {
        id: "legacy-rpc-1",
        type: "get_state",
      },
    ]);
  });

  it("resumes cold sessions through SDK SessionManager.open by default", async () => {
    const sessionManager = {
      getCwd: vi.fn(() => process.cwd()),
      getSessionFile: vi.fn(
        () => "/Users/void/.pi/agent/sessions/project/pi-session-resumed.jsonl",
      ),
    };
    const sdkSession = createFakeSdkAgentSession();
    sdkSession.session.sessionId = "pi-session-resumed";
    sdkSession.session.sessionManager = sessionManager;
    sessionManagerOpen.mockReturnValue(sessionManager);
    createAgentSession.mockResolvedValue({ session: sdkSession.session });
    const projections = createInMemorySessionProjectionStore();
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      runtimeJournal: createInMemorySessionEventJournal(),
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-resume",
        method: "resume_session",
        params: {
          sessionId: "session-resumed",
          projectId: "project-1",
          piSessionId: "pi-session-resumed",
          sessionFile: "/Users/void/.pi/agent/sessions/project/pi-session-resumed.jsonl",
          cwd: "/fallback/cwd",
        },
      }),
    ).resolves.toEqual({
      id: "req-resume",
      result: expect.objectContaining({
        sessionId: "session-resumed",
        runtimeId: "pi-sdk:session-resumed",
        piSessionId: "pi-session-resumed",
        cwd: process.cwd(),
        sessionFile: "/Users/void/.pi/agent/sessions/project/pi-session-resumed.jsonl",
      }),
    });
    expect(sessionManagerOpen).toHaveBeenCalledWith(
      "/Users/void/.pi/agent/sessions/project/pi-session-resumed.jsonl",
    );
    expect(createAgentSession).toHaveBeenCalledWith({
      cwd: process.cwd(),
      sessionManager,
    });
    await expect(projections.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-resumed",
        piSessionId: "pi-session-resumed",
        sessionFile: "/Users/void/.pi/agent/sessions/project/pi-session-resumed.jsonl",
      }),
    ]);
  });

  it("forks cold sessions through SDK SessionManager.open by default", async () => {
    const sourceSessionFile =
      "/Users/void/.pi/agent/sessions/project/pi-session-source.jsonl";
    const forkedSessionFile =
      "/Users/void/.pi/agent/sessions/project/pi-session-forked.jsonl";
    let currentSessionFile = sourceSessionFile;
    const sessionManager = {
      getCwd: vi.fn(() => process.cwd()),
      getSessionFile: vi.fn(() => currentSessionFile),
      getEntry: vi.fn(() => ({
        type: "message",
        id: "pi-entry-user-2",
        parentId: "pi-entry-parent",
        message: {
          role: "user",
          content: "Revise this branch",
        },
      })),
      createBranchedSession: vi.fn(() => {
        currentSessionFile = forkedSessionFile;

        return forkedSessionFile;
      }),
    };
    const sdkSession = createFakeSdkAgentSession();
    const journal = createInMemorySessionEventJournal();
    const projections = createInMemorySessionProjectionStore();

    sdkSession.session.sessionId = "pi-session-forked";
    sessionManagerOpen.mockReturnValue(sessionManager);
    createAgentSession.mockImplementation(async ({ sessionManager: manager }) => {
      sdkSession.session.sessionManager = manager;

      return { session: sdkSession.session };
    });
    journal.append({
      id: "evt-source-user",
      seq: 1,
      sessionId: "session-source",
      piSessionId: "pi-session-source",
      type: "message_update",
      ts: "2026-07-03T12:00:00.000Z",
      payload: {
        kind: "message",
        role: "user",
        body: "Revise this branch",
        piEntryId: "pi-entry-user-2",
      },
    });
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      runtimeJournal: journal,
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-fork",
        method: "fork_session",
        params: {
          sessionId: "session-forked",
          projectId: "project-1",
          sourcePiSessionId: "pi-session-source",
          sourceSessionFile,
          piEntryId: "pi-entry-user-2",
          cwd: "/fallback/cwd",
        },
      }),
    ).resolves.toEqual({
      id: "req-fork",
      result: {
        selectedText: "Revise this branch",
        snapshot: expect.objectContaining({
          sessionId: "session-forked",
          runtimeId: "pi-sdk:session-forked",
          piSessionId: "pi-session-forked",
          cwd: process.cwd(),
          sessionFile: forkedSessionFile,
        }),
      },
    });
    expect(sessionManagerOpen).toHaveBeenCalledWith(sourceSessionFile);
    expect(sessionManager.getEntry).toHaveBeenCalledWith("pi-entry-user-2");
    expect(sessionManager.createBranchedSession).toHaveBeenCalledWith(
      "pi-entry-parent",
    );
    expect(createAgentSession).toHaveBeenCalledWith({
      cwd: process.cwd(),
      sessionManager,
    });
    await expect(projections.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-forked",
        piSessionId: "pi-session-forked",
        initialPrompt: "Revise this branch",
        sessionFile: forkedSessionFile,
      }),
    ]);
  });

  it("lists persisted Session Projections and repairs missing Pi session files", async () => {
    const projections = createInMemorySessionProjectionStore();

    await projections.save({
      sessionId: "session-1",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-sdk",
      projectId: "project-1",
      cwd: process.cwd(),
      status: "idle",
      updatedAt: "2026-07-03T10:00:00.000Z",
    });

    const piSessionListAll = vi.fn(async () => [
      {
        id: "pi-session-sdk",
        path: "/Users/void/.pi/agent/sessions/project/pi-session-sdk.jsonl",
      },
    ]);
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      piSessionListAll,
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-projections",
        method: "list_session_projections",
      }),
    ).resolves.toEqual({
      id: "req-projections",
      result: [
        expect.objectContaining({
          sessionId: "session-1",
          piSessionId: "pi-session-sdk",
          sessionFile: "/Users/void/.pi/agent/sessions/project/pi-session-sdk.jsonl",
        }),
      ],
    });
    expect(piSessionListAll).toHaveBeenCalledTimes(1);
    await expect(projections.list()).resolves.toEqual([
      expect.objectContaining({
        sessionFile: "/Users/void/.pi/agent/sessions/project/pi-session-sdk.jsonl",
      }),
    ]);
  });

  it("does not repeatedly scan all Pi sessions for unrecoverable Projections", async () => {
    const projections = createInMemorySessionProjectionStore();

    await projections.save({
      sessionId: "session-1",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-missing",
      projectId: "project-1",
      cwd: process.cwd(),
      status: "idle",
      updatedAt: "2026-07-03T10:00:00.000Z",
    });

    const piSessionListAll = vi.fn(async () => []);
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      piSessionListAll,
      piRpc: createFakePiRpcTransport(),
    });

    await service.handleRequest({
      id: "req-projections-1",
      method: "list_session_projections",
    });
    await expect(
      service.handleRequest({
        id: "req-projections-2",
        method: "list_session_projections",
      }),
    ).resolves.toEqual({
      id: "req-projections-2",
      result: [
        expect.objectContaining({
          sessionId: "session-1",
          sessionFileMissing: true,
        }),
      ],
    });
    expect(piSessionListAll).toHaveBeenCalledTimes(1);
  });

  it("only saves projections whose session file repair changed", async () => {
    const projections = createInMemorySessionProjectionStore();
    const save = vi.spyOn(projections, "save");

    await projections.save({
      sessionId: "session-1",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-sdk",
      projectId: "project-1",
      cwd: process.cwd(),
      status: "idle",
      updatedAt: "2026-07-03T10:00:00.000Z",
    });
    await projections.save({
      sessionId: "session-2",
      runtimeId: "pi-sdk:session-2",
      piSessionId: "pi-session-present",
      projectId: "project-1",
      cwd: process.cwd(),
      status: "idle",
      sessionFile: "/Users/void/.pi/agent/sessions/project/pi-session-present.jsonl",
      updatedAt: "2026-07-03T10:01:00.000Z",
    });
    save.mockClear();

    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      piSessionListAll: vi.fn(async () => [
        {
          id: "pi-session-sdk",
          path: "/Users/void/.pi/agent/sessions/project/pi-session-sdk.jsonl",
        },
      ]),
      piRpc: createFakePiRpcTransport(),
    });

    await service.handleRequest({
      id: "req-projections",
      method: "list_session_projections",
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionFile: "/Users/void/.pi/agent/sessions/project/pi-session-sdk.jsonl",
      }),
    );
  });

  it("heals cold-list updatedAt from journal last chat activity (DF-012)", async () => {
    const projections = createInMemorySessionProjectionStore();
    const journal = createInMemorySessionEventJournal();

    await projections.save({
      sessionId: "session-old",
      runtimeId: "pi-sdk:session-old",
      piSessionId: "pi-session-old",
      projectId: "project-1",
      cwd: process.cwd(),
      status: "completed",
      sessionFile: "/Users/void/.pi/agent/sessions/project/pi-session-old.jsonl",
      // Last open stamped today — list would show same-day until open.
      updatedAt: "2026-08-07T05:00:41.401Z",
    });

    journal.append({
      id: "evt-user-msg",
      seq: 8,
      sessionId: "session-old",
      piSessionId: "pi-session-old",
      type: "message_update",
      ts: "2026-08-01T12:00:00.000Z",
      payload: { kind: "message", role: "user", body: "Start the task" },
    });
    journal.append({
      id: "evt-last-msg",
      seq: 9,
      sessionId: "session-old",
      piSessionId: "pi-session-old",
      type: "message_update",
      ts: "2026-08-01T12:03:34.764Z",
      payload: {
        kind: "message",
        role: "assistant",
        body: "Last real answer",
      },
    });

    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      runtimeJournal: journal,
      piSessionListAll: vi.fn(async () => []),
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-projections-heal",
        method: "list_session_projections",
      }),
    ).resolves.toEqual({
      id: "req-projections-heal",
      result: [
        expect.objectContaining({
          sessionId: "session-old",
          lastUserMessageAt: "2026-08-01T12:00:00.000Z",
          updatedAt: "2026-08-01T12:03:34.764Z",
        }),
      ],
    });

    await expect(projections.get("session-old")).resolves.toMatchObject({
      lastUserMessageAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:03:34.764Z",
    });

    journal.append({
      id: "evt-delayed-queue",
      seq: 10,
      sessionId: "session-old",
      piSessionId: "pi-session-old",
      type: "message_update",
      ts: "2026-08-01T12:04:00.000Z",
      payload: { kind: "message", role: "user", body: "Queued follow-up" },
    });
    await service.handleRequest({ id: "list-again", method: "list_session_projections" });
    expect(await projections.get("session-old")).toMatchObject({
      lastUserMessageAt: "2026-08-01T12:00:00.000Z",
    });
  });

  it("opens terminals in the session checkout root and forwards terminal events", async () => {
    const projections = createInMemorySessionProjectionStore();

    await projections.save({
      sessionId: "session-term",
      runtimeId: "runtime-term",
      piSessionId: "pi-term",
      projectId: "project-1",
      cwd: "/projection/cwd",
      status: "idle",
      checkout: {
        root: "/source/repo",
        executionCheckoutRoot: "/checkout",
      },
      updatedAt: "2026-09-02T00:00:00.000Z",
    });

    const terminalManager = createFakeTerminalManager();
    // The checkout root must short-circuit cwd resolution; a live runtime is
    // never consulted when the projection records a checkout.
    const runtimeDriver = {
      getSnapshot: vi.fn(async () => {
        throw new Error("runtime is not live");
      }),
      onEvent: vi.fn(() => () => {}),
    } as unknown as PiRuntimeDriver;
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      runtimeDriver,
      runtimeJournal: createInMemorySessionEventJournal(),
      terminalManager: terminalManager.manager,
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-open-terminal",
        method: "open_terminal",
        params: { sessionId: "session-term", cols: 120, rows: 40 },
      }),
    ).resolves.toEqual({
      id: "req-open-terminal",
      result: {
        terminalId: "term-fake-1",
        sessionId: "session-term",
        cwd: "/checkout",
        status: "running",
      },
    });
    expect(terminalManager.created).toEqual([
      {
        sessionId: "session-term",
        piSessionId: "pi-term",
        cwd: "/checkout",
        cols: 120,
        rows: 40,
      },
    ]);
    expect(runtimeDriver.getSnapshot).not.toHaveBeenCalled();

    const events: import("./service").BackendRpcEvent[] = [];
    service.onEvent((event) => {
      events.push(event);
    });
    terminalManager.emit({
      kind: "output",
      terminalId: "term-fake-1",
      sessionId: "session-term",
      piSessionId: "pi-term",
      data: "hello",
      end: 5,
    });
    terminalManager.emit({
      kind: "exit",
      terminalId: "term-fake-1",
      sessionId: "session-term",
      piSessionId: "pi-term",
      exitCode: 0,
    });

    expect(events).toEqual([
      {
        type: "event",
        event: {
          id: expect.stringMatching(/^evt-/),
          seq: 0,
          sessionId: "session-term",
          piSessionId: "pi-term",
          type: "terminal_output",
          ts: expect.any(String),
          payload: { terminalId: "term-fake-1", data: "hello", end: 5 },
        },
      },
      {
        type: "event",
        event: {
          id: expect.stringMatching(/^evt-/),
          seq: 0,
          sessionId: "session-term",
          piSessionId: "pi-term",
          type: "terminal_exit",
          ts: expect.any(String),
          payload: { terminalId: "term-fake-1", exitCode: 0 },
        },
      },
    ]);
  });

  it("falls back to the runtime snapshot cwd when the session has no checkout", async () => {
    const projections = createInMemorySessionProjectionStore();

    await projections.save({
      sessionId: "session-term-live",
      runtimeId: "runtime-term-live",
      piSessionId: "pi-term-live",
      projectId: "project-1",
      cwd: "/projection/cwd",
      status: "idle",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });

    const runtimeDriver = {
      getSnapshot: vi.fn(async () => ({
        sessionId: "session-term-live",
        runtimeId: "runtime-term-live",
        piSessionId: "pi-term-live",
        projectId: "project-1",
        cwd: "/runtime/cwd",
        status: "idle" as const,
        events: [],
        updatedAt: "2026-09-02T00:00:00.000Z",
      })),
      onEvent: vi.fn(() => () => {}),
    } as unknown as PiRuntimeDriver;
    const terminalManager = createFakeTerminalManager();
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      runtimeDriver,
      runtimeJournal: createInMemorySessionEventJournal(),
      terminalManager: terminalManager.manager,
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-open-terminal",
        method: "open_terminal",
        params: { sessionId: "session-term-live", cols: 80, rows: 24 },
      }),
    ).resolves.toEqual({
      id: "req-open-terminal",
      result: expect.objectContaining({ cwd: "/runtime/cwd" }),
    });
    expect(terminalManager.created).toEqual([
      expect.objectContaining({
        sessionId: "session-term-live",
        piSessionId: "pi-term-live",
        cwd: "/runtime/cwd",
      }),
    ]);
  });

  it("rejects open_terminal without a projection, checkout, or runtime cwd", async () => {
    const projections = createInMemorySessionProjectionStore();

    await projections.save({
      sessionId: "session-term-cold",
      runtimeId: "runtime-term-cold",
      piSessionId: "pi-term-cold",
      projectId: "project-1",
      cwd: "/projection/cwd",
      status: "completed",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });

    const runtimeDriver = {
      getSnapshot: vi.fn(async () => {
        throw new Error('Pi SDK runtime "pi-term-cold" was not found.');
      }),
      onEvent: vi.fn(() => () => {}),
    } as unknown as PiRuntimeDriver;
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: projections,
      runtimeDriver,
      runtimeJournal: createInMemorySessionEventJournal(),
      terminalManager: createFakeTerminalManager().manager,
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-open-cold",
        method: "open_terminal",
        params: { sessionId: "session-term-cold", cols: 80, rows: 24 },
      }),
    ).resolves.toEqual({
      id: "req-open-cold",
      error: "Session has no checkout or runtime cwd to open a terminal in.",
    });
    await expect(
      service.handleRequest({
        id: "req-open-missing",
        method: "open_terminal",
        params: { sessionId: "session-gone", cols: 80, rows: 24 },
      }),
    ).resolves.toEqual({
      id: "req-open-missing",
      error: 'Session projection "session-gone" was not found.',
    });
  });

  it("routes terminal input, resize, attach, list, and close to the terminal manager", async () => {
    const terminalManager = createFakeTerminalManager();
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      sessionProjectionStore: createInMemorySessionProjectionStore(),
      runtimeJournal: createInMemorySessionEventJournal(),
      terminalManager: terminalManager.manager,
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-input",
        method: "terminal_input",
        params: { terminalId: "term-fake-1", data: "\r" },
      }),
    ).resolves.toEqual({ id: "req-input", result: null });
    expect(terminalManager.write).toHaveBeenCalledWith("term-fake-1", "\r");

    await expect(
      service.handleRequest({
        id: "req-input-missing-data",
        method: "terminal_input",
        params: { terminalId: "term-fake-1" },
      }),
    ).resolves.toEqual({ id: "req-input-missing-data", error: "data is required" });

    await expect(
      service.handleRequest({
        id: "req-resize",
        method: "resize_terminal",
        params: { terminalId: "term-fake-1", cols: 0, rows: 9999 },
      }),
    ).resolves.toEqual({ id: "req-resize", result: null });
    expect(terminalManager.resize).toHaveBeenCalledWith("term-fake-1", 1, 500);

    await expect(
      service.handleRequest({
        id: "req-attach",
        method: "attach_terminal",
        params: { terminalId: "term-fake-1" },
      }),
    ).resolves.toEqual({ id: "req-attach", result: { scrollback: "replay", end: 6 } });
    await expect(
      service.handleRequest({
        id: "req-list",
        method: "list_terminals",
        params: { sessionId: "session-term" },
      }),
    ).resolves.toEqual({ id: "req-list", result: [] });
    await expect(
      service.handleRequest({
        id: "req-close",
        method: "close_terminal",
        params: { terminalId: "term-fake-1" },
      }),
    ).resolves.toEqual({ id: "req-close", result: null });
    expect(terminalManager.close).toHaveBeenCalledWith("term-fake-1");
  });

  it("creates a chat workspace directory through prepare_chat_workspace", async () => {
    const dataDir = await tempDataDir();
    const sessionId = "session-rpc-chat";
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      dataDir,
      runtimeDriver: {
        onEvent: vi.fn(() => () => {}),
      } as unknown as PiRuntimeDriver,
      runtimeJournal: createInMemorySessionEventJournal(),
      piRpc: createFakePiRpcTransport(),
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

  it("labels list_sessions under the service dataDir chats root as Chat", async () => {
    const dataDir = await tempDataDir();
    const agentDir = await tempDataDir();
    const sessionId = "session-chat-label";
    const cwd = join(dataDir, "chats", sessionId);
    const sessionDir = join(agentDir, "sessions", "chat");

    expect(dataDir).not.toBe(resolveDataDir(process.env, await tempDataDir()));

    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "2026-09-07T12-00-00-000Z_session-chat-label.jsonl"),
      `{"type":"session","id":"${sessionId}","timestamp":"2026-09-07T12:00:00.000Z","cwd":${JSON.stringify(cwd)}}`,
    );

    const service = createBackendService({
      agentDir,
      dataDir,
      runtimeDriver: {
        onEvent: vi.fn(() => () => {}),
      } as unknown as PiRuntimeDriver,
      runtimeJournal: createInMemorySessionEventJournal(),
      piRpc: createFakePiRpcTransport(),
    });

    const response = await service.handleRequest({
      id: "req-list",
      method: "list_sessions",
    });

    expect(response).toEqual({
      id: "req-list",
      result: [
        expect.objectContaining({
          id: sessionId,
          project: "Chat",
        }),
      ],
    });
  });

  it("returns the chat workspace root through get_chat_workspace_root", async () => {
    const dataDir = await tempDataDir();
    const service = createBackendService({
      agentDir: fixtureAgentDir(),
      dataDir,
      runtimeDriver: {
        onEvent: vi.fn(() => () => {}),
      } as unknown as PiRuntimeDriver,
      runtimeJournal: createInMemorySessionEventJournal(),
      piRpc: createFakePiRpcTransport(),
    });

    await expect(
      service.handleRequest({
        id: "req-chat-root",
        method: "get_chat_workspace_root",
      }),
    ).resolves.toEqual({
      id: "req-chat-root",
      result: { path: join(dataDir, "chats") },
    });
    await expect(stat(join(dataDir, "chats"))).rejects.toThrow();
  });
});

describe("workspace invalidation delivery", () => {
  afterEach(() => vi.useRealTimers());

  it("flushes explicit stop and successful checkout, and releases deleted siblings", async () => {
    vi.useFakeTimers();
    const projections = createInMemorySessionProjectionStore();
    for (const id of ["a", "b"]) await projections.save({
      sessionId: id, piSessionId: `pi-${id}`, runtimeId: id, projectId: "/repo", cwd: "/repo",
      status: "idle", checkout: { root: "/repo" }, updatedAt: "2026-09-11T00:00:00Z",
    });
    let emit!: Parameters<PiRuntimeDriver["onEvent"]>[0];
    let finishStop!: () => void;
    const stopping = new Promise<void>((resolve) => { finishStop = resolve; });
    const service = createBackendService({ sessionProjectionStore: projections,
      runtimeJournal: createInMemorySessionEventJournal(),
      sessionChangesReader: { read: vi.fn(), checkoutBranch: vi.fn().mockResolvedValue({ state: "clean" }) },
      runtimeDriver: { onEvent: (listener: Parameters<PiRuntimeDriver["onEvent"]>[0]) => { emit = listener; return () => {}; },
        stopRun: async () => {
          await stopping;
          return { sessionId: "a", piSessionId: "pi-a", type: "stopped", payload: {} };
        },
      } as unknown as PiRuntimeDriver, piRpc: createFakePiRpcTransport() });
    const delivered: string[][] = [];
    service.onEvent(({ event }) => {
      if (event.type === "workspace.invalidated") delivered.push(event.payload.sessionIds as string[]);
    });
    await service.handleRequest({ id: "checkout", method: "checkout_session_branch", params: { sessionId: "a", branch: "main" } });
    expect(delivered).toEqual([["a", "b"]]);
    emit({
      sessionId: "a", piSessionId: "pi-a", type: "tool",
      payload: { type: "tool", phase: "end", runId: "run", turnId: "turn",
        toolCallId: "tool", name: "bash", surface: "trace", origin: "sdk" },
    });
    const stop = service.handleRequest({ id: "stop", method: "stop_run", params: { piSessionId: "pi-a" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveLength(2);
    finishStop();
    await stop;
    expect(await service.handleRequest({ id: "delete", method: "delete_session", params: { sessionId: "b" } })).not.toHaveProperty("error");
    emit({
      sessionId: "a", piSessionId: "pi-a", type: "tool",
      payload: { type: "tool", phase: "end", runId: "run", turnId: "turn",
        toolCallId: "tool", name: "bash", surface: "trace", origin: "sdk" },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(delivered[delivered.length - 1]).toEqual(["a"]);
  });

  it("fans failed tool hints out to checkout siblings without journaling the notification", async () => {
    vi.useFakeTimers();
    const projections = createInMemorySessionProjectionStore();
    for (const id of ["a", "b", "chat", "other"]) {
      await projections.save({ sessionId: id, piSessionId: `pi-${id}`, runtimeId: id,
        projectId: id === "chat" ? "chat" : "/repo", cwd: "/repo", status: "idle",
        checkout: { executionCheckoutRoot: id === "other" ? "/other" : "/repo", diffRoot: `/repo/${id}` },
        updatedAt: "2026-09-11T00:00:00Z" });
    }
    let emit!: Parameters<PiRuntimeDriver["onEvent"]>[0];
    const journal = createInMemorySessionEventJournal();
    const read = vi.fn();
    const service = createBackendService({ sessionProjectionStore: projections, runtimeJournal: journal,
      sessionChangesReader: { read, checkoutBranch: vi.fn() },
      runtimeDriver: { onEvent: (listener: Parameters<PiRuntimeDriver["onEvent"]>[0]) => { emit = listener; return () => {}; } } as PiRuntimeDriver,
      piRpc: createFakePiRpcTransport() });
    const events: import("./service").BackendRpcEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.handleRequest({ id: "init", method: "list_session_projections" });
    const hint = (type: string, id = "a") => emit({ sessionId: id, piSessionId: `pi-${id}`, type,
      payload: { type, phase: "end", isError: true, runId: "run", turnId: "turn", toolCallId: "tool", name: "bash", surface: "trace", origin: "sdk" } });
    hint("tool");
    hint("tool", "b");
    hint("tool", "chat");
    hint("turn");
    hint("run");
    await vi.advanceTimersByTimeAsync(2500);
    const invalidations = events.filter((event) => event.event?.type === "workspace.invalidated");
    expect(invalidations).toEqual([expect.objectContaining({ type: "event", event: expect.objectContaining({ seq: 0,
      payload: { checkoutId: "/repo", sessionIds: ["a", "b"], source: "tool" } }) })]);
    expect(read).not.toHaveBeenCalled();
    const recorded = await journal.read("pi-a");
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.some((event) => event.type === "workspace.invalidated")).toBe(false);
    expect(await projections.get("b")).toMatchObject({ status: "idle" });
  });
});

it("delivers external Git changes to linked checkout siblings without a runtime event", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "service-git-watch-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Watcher test");
  git("config", "user.email", "watcher@example.test");
  git("commit", "--allow-empty", "-m", "initial");
  const linked = join(root, "linked");
  git("worktree", "add", "--detach", linked);
  const alias = join(root, "alias");
  symlinkSync(linked, alias, "dir");
  const projections = createInMemorySessionProjectionStore();
  for (const [id, checkoutRoot] of [["a", linked], ["b", alias], ["chat", linked]]) {
    await projections.save({ sessionId: id!, piSessionId: `pi-${id}`, runtimeId: id!,
      projectId: id === "chat" ? "chat" : root, cwd: checkoutRoot!, status: "idle",
      checkout: { mode: "foreground-local", root: checkoutRoot! }, updatedAt: "2026-09-11T00:00:00Z" });
  }
  const read = vi.fn();
  const service = createBackendService({ dataDir: join(root, "data"), sessionProjectionStore: projections,
    runtimeJournal: createInMemorySessionEventJournal(), sessionChangesReader: { read, checkoutBranch: vi.fn() },
    runtimeDriver: { onEvent: () => () => {} } as unknown as PiRuntimeDriver, piRpc: createFakePiRpcTransport() });
  const delivered: unknown[] = [];
  service.onEvent(({ event }) => { if (event.type === "workspace.invalidated") delivered.push(event.payload); });
  try {
    await service.handleRequest({ id: "init", method: "list_session_projections" });
    execFileSync("git", ["-C", linked, "checkout", "-b", "external"], { stdio: "pipe" });
    await vi.waitFor(() => expect(delivered).toContainEqual({ checkoutId: linked, sessionIds: ["a", "b"], source: "git-watch" }), { timeout: 3000, interval: 20 });
    expect(read).not.toHaveBeenCalled();
  } finally {
    for (const id of ["a", "b", "chat"]) {
      await service.handleRequest({ id: `delete-${id}`, method: "delete_session", params: { sessionId: id } });
    }
    await rm(root, { recursive: true, force: true });
  }
});

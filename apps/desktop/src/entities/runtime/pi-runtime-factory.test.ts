import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultPiRuntimeBridge } from "@/entities/runtime/pi-runtime-factory";

describe("default Pi runtime bridge factory", () => {
  afterEach(() => {
    delete window.pace;
  });

  it("uses an in-browser fake bridge outside Electron so dev-server sessions stay interactive", async () => {
    const bridge = createDefaultPiRuntimeBridge({
      now: () => "2026-06-26T08:00:00.000Z",
    });
    const runtime = await bridge.startRuntime({
      sessionId: "session-browser",
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
      bridge.queueFollowUp({
        piSessionId: state.piSessionId,
        message: "Queue a browser fallback follow-up.",
      }),
    ).resolves.toMatchObject({
      status: "pending",
      body: "Queue a browser fallback follow-up.",
    });
  });

  it("uses the Runtime Gateway client in Electron by default", async () => {
    const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
      invocations.push({ command, args });

      return {
        sessionId: "session-electron",
        runtimeId: "pi-sdk:session-electron",
        piSessionId: "pi-session-electron",
        projectId: "pig",
        cwd: "/Users/void/code/opensource/Pig",
        status: "idle",
        events: [],
        updatedAt: "2026-06-29T12:00:00.000Z",
      } as T;
    };

    window.pace = {
      invoke,
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    const bridge = createDefaultPiRuntimeBridge();
    const runtime = await bridge.startRuntime({
      sessionId: "session-electron",
      projectId: "pig",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig",
      },
    });

    expect(runtime.runtimeId).toBe("pi-sdk:session-electron");
    expect(invocations).toEqual([
      {
        command: "create_session",
        args: {
          sessionId: "session-electron",
          projectId: "pig",
          cwd: "/Users/void/code/opensource/Pig",
          checkout: {
            mode: "foreground-local",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig",
          },
        },
      },
    ]);
  });
});

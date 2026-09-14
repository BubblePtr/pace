import { browserSessionSummaries } from "@/fixtures/browser-session-summaries";
import type { BackendRpcEvent } from "@pace/backend";
import type { BrowserEvent } from "@/shared/browser-protocol";
import type { NavigateRequest } from "@/shared/navigate-protocol";
import type { UpdateStatus } from "@/shared/update-protocol";
import type { SessionDetail } from "@/pages/session-detail";
import type { SessionSummary } from "@/entities/session/sessions";

declare global {
  interface Window {
    pace?: PaceRendererApi;
  }
}

export type PaceRendererApi = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  onBackendEvent(listener: (event: BackendRpcEvent) => void): () => void;
  /** Embedded browser view events; main-process only, never the backend. */
  onBrowserEvent(listener: (event: BrowserEvent) => void): () => void;
  onUpdateEvent(listener: (event: UpdateStatus) => void): () => void;
  onWindowFocusChanged(listener: () => void): () => void;
  onNavigateRequest(listener: (request: NavigateRequest) => void): () => void;
};

type InvokeArgs = Record<string, unknown>;

const emptyConfigInventory = {
  packages: [],
  extensions: [],
  skills: [],
  promptTemplates: [],
  themes: [],
};
const browserSessionSummaryFixture: SessionSummary[] = browserSessionSummaries;

export function isElectronRuntime() {
  return typeof window !== "undefined" && window.pace !== undefined;
}

function browserSessionDetail(summary: SessionSummary): SessionDetail {
  return {
    id: summary.id,
    timestamp: summary.timestamp,
    project: summary.project,
    totalCostUsd: summary.totalCostUsd,
    totalTokens: summary.totalTokens,
    primaryModel: summary.primaryModel,
    turnCount: 3,
    durationSeconds: 420,
    turns: [
      {
        kind: "message",
        role: "user",
        timestamp: summary.timestamp,
        parts: [
          {
            partType: "text",
            text: `Inspect ${summary.project} trajectory usage and layout behavior.`,
            payload: {},
          },
        ],
      },
      {
        kind: "message",
        role: "assistant",
        timestamp: summary.timestamp,
        model: summary.primaryModel,
        usage: {
          inputTokens: Math.round(summary.totalTokens * 0.42),
          outputTokens: Math.round(summary.totalTokens * 0.38),
          cacheReadTokens: Math.round(summary.totalTokens * 0.16),
          cacheWriteTokens: Math.max(0, summary.totalTokens - Math.round(summary.totalTokens * 0.96)),
          totalTokens: summary.totalTokens,
        },
        cost: {
          inputUsd: summary.totalCostUsd * 0.34,
          outputUsd: summary.totalCostUsd * 0.5,
          cacheReadUsd: summary.totalCostUsd * 0.1,
          cacheWriteUsd: summary.totalCostUsd * 0.06,
          totalUsd: summary.totalCostUsd,
        },
        parts: [
          {
            partType: "thinking",
            text: [
              "Read the current workspace state.",
              "Compare the rendered layout with the target fixed-pane behavior.",
              "Keep trajectory output scoped to the detail panel.",
            ].join("\n"),
            payload: {},
          },
          {
            partType: "toolCall",
            name: "read_file",
            payload: {
              input: {
                path: "src/trace.tsx",
              },
            },
          },
          {
            partType: "toolResult",
            name: "read_file",
            text: "Trajectory workspace uses a fixed split layout with independent scroll panes.",
            payload: {},
          },
        ],
      },
      {
        kind: "annotation",
        title: "Browser development fixture",
        timestamp: summary.timestamp,
        parts: [
          {
            partType: "text",
            text: "This trajectory detail is generated from browser-session-summaries.json for web-only debugging outside Electron.",
            payload: {},
          },
        ],
      },
    ],
  };
}

export function invokeBrowserFallback<T>(command: string, args?: InvokeArgs): Promise<T> {
  switch (command) {
    case "update:status":
    case "update:check":
    case "update:install":
      return Promise.resolve({
        state: "disabled",
        currentVersion: "development",
        reason: "Updates are only available in the packaged desktop app.",
      } as T);
    case "select_project_directory": {
      if (typeof window === "undefined") {
        return Promise.resolve(null as T);
      }

      const selectedPath = window.prompt("Project path");

      return Promise.resolve((selectedPath?.trim() || null) as T);
    }
    case "reveal_project_in_finder":
      return Promise.resolve(undefined as T);
    case "get_chat_workspace_root":
      return Promise.resolve({ path: "/tmp/pigui-chats" } as T);
    case "list_session_projections":
      return Promise.resolve([] as T);
    case "list_sessions":
      return Promise.resolve(browserSessionSummaryFixture as T);
    case "get_session_detail": {
      const id = typeof args?.id === "string" ? args.id : "";
      const summary = browserSessionSummaryFixture.find((session) => session.id === id);
      if (!summary) {
        return Promise.reject(new Error(`Browser session fixture "${id}" was not found.`));
      }
      return Promise.resolve(browserSessionDetail(summary) as T);
    }
    case "select_local_resource":
      return Promise.resolve(null as T);
    case "add_local_resource":
      return Promise.reject(new Error("Local resources require the desktop app"));
    case "remove_local_resource":
    case "install_package":
    case "update_package":
    case "set_resource_enabled":
      return Promise.resolve({ progress: [] } as T);
    case "remove_package":
      return Promise.resolve({ removed: true, progress: [] } as T);
    case "search_package_catalog":
      return Promise.reject(new Error("The package catalogue requires the desktop app"));
    case "check_package_updates":
      return Promise.resolve({ updates: [], progress: [] } as T);
    case "get_config_inventory":
      return Promise.resolve(emptyConfigInventory as T);
    case "run_environment_preflight":
      return Promise.resolve({
        checkedAt: new Date().toISOString(),
        checks: [
          {
            id: "pi_runtime",
            severity: "required",
            status: "pass",
            title: "Pi Runtime",
            summary: "Browser development fixture",
          },
          {
            id: "data_directory",
            severity: "required",
            status: "pass",
            title: "Data directory",
            summary: "Browser development fixture",
          },
          {
            id: "model_auth",
            severity: "required",
            status: "pass",
            title: "Model auth",
            summary: "Browser development fixture",
          },
          {
            id: "git",
            severity: "optional",
            status: "skip",
            title: "Git",
            summary: "Browser development fixture",
          },
        ],
        requiredPassed: true,
        optionalFailed: false,
        canContinue: true,
      } as T);
    case "get_environment_preflight_status":
      return Promise.resolve({ completedAt: "2026-07-25T00:00:00.000Z" } as T);
    case "complete_environment_preflight":
      return Promise.resolve({ completedAt: new Date().toISOString() } as T);
    case "list_provider_auth_status":
      return Promise.resolve({
        agentDir: "/browser-dev",
        authPath: "/browser-dev/auth.json",
        configuredCount: 1,
        providers: [
          {
            id: "openai",
            label: "OpenAI",
            supportsApiKey: true,
            supportsOAuth: false,
            mode: "api_key",
            configured: true,
            keyHint: "…dev1",
          },
          {
            id: "openai-codex",
            label: "ChatGPT / Codex",
            supportsApiKey: false,
            supportsOAuth: true,
            mode: "none",
            configured: false,
          },
          {
            id: "anthropic",
            label: "Anthropic",
            supportsApiKey: true,
            supportsOAuth: true,
            mode: "none",
            configured: false,
          },
          {
            id: "deepseek",
            label: "DeepSeek",
            supportsApiKey: true,
            supportsOAuth: false,
            mode: "none",
            configured: false,
          },
          {
            id: "xai",
            label: "Grok (xAI)",
            supportsApiKey: true,
            supportsOAuth: true,
            mode: "none",
            configured: false,
          },
        ],
      } as T);
    case "set_provider_api_key":
    case "remove_provider_auth":
    case "login_provider_oauth":
    case "logout_provider_auth":
      return invokeBrowserFallback("list_provider_auth_status");
    case "resolve_tool_schemas":
      return Promise.resolve({ schemas: {} } as T);
    case "list_available_model_controls":
      return Promise.resolve({
        models: [
          {
            provider: "openai",
            modelId: "gpt-4.1",
            name: "GPT-4.1",
            thinkingLevels: ["off"],
          },
        ],
        selected: {
          provider: "openai",
          modelId: "gpt-4.1",
          thinkingLevel: "off",
        },
      } as T);
    default:
      return Promise.reject(
        new Error(`Backend command "${command}" is unavailable outside Electron.`),
      );
  }
}

/**
 * Electron re-throws whatever an `ipcMain.handle` handler raised, wrapped in
 * its own channel prefix. Surfaces read these messages out to the user, so the
 * wrapper is stripped once here rather than in every error state.
 */
const electronInvokeWrapper = /^Error invoking remote method '[^']*': (?:Error: )?/;

function unwrapInvokeError(error: unknown) {
  if (!(error instanceof Error) || !electronInvokeWrapper.test(error.message)) {
    return error;
  }

  return new Error(error.message.replace(electronInvokeWrapper, ""));
}

export function invoke<T>(command: string, args?: InvokeArgs) {
  if (isElectronRuntime()) {
    return window.pace!.invoke<T>(command, args).catch((error: unknown) => {
      throw unwrapInvokeError(error);
    });
  }

  return invokeBrowserFallback<T>(command, args);
}

export function selectProjectDirectory() {
  return invoke<string | null>("select_project_directory");
}

export function revealProjectInFinder(
  path: string,
  options?: { ensure?: boolean },
) {
  return invoke<void>(
    "reveal_project_in_finder",
    options?.ensure ? { path, ensure: true } : { path },
  );
}

export async function onWindowFocusChanged(refetch: () => unknown) {
  if (isElectronRuntime()) {
    return window.pace!.onWindowFocusChanged(() => {
      void refetch();
    });
  }

  if (typeof window === "undefined") {
    return () => {};
  }

  const handleFocus = () => {
    void refetch();
  };

  window.addEventListener("focus", handleFocus);
  return () => {
    window.removeEventListener("focus", handleFocus);
  };
}

export function onBackendEvent(listener: (event: BackendRpcEvent) => void) {
  if (!isElectronRuntime()) {
    return () => {};
  }

  return window.pace!.onBackendEvent(listener);
}

export function onBrowserEvent(listener: (event: BrowserEvent) => void) {
  if (!isElectronRuntime()) {
    return () => {};
  }

  return window.pace!.onBrowserEvent(listener);
}

export function onUpdateEvent(listener: (event: UpdateStatus) => void) {
  if (!isElectronRuntime()) {
    return () => {};
  }

  return window.pace!.onUpdateEvent(listener);
}

export function onNavigateRequest(listener: (request: NavigateRequest) => void) {
  if (!isElectronRuntime()) {
    return () => {};
  }

  return window.pace!.onNavigateRequest(listener);
}

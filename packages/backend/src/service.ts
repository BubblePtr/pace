import { createGitMetadataWatchers } from "./workspace/git-metadata-watcher";
import { CHAT_PROJECT_ID } from "@pace/core";
import { createWorkspaceInvalidation } from "./workspace/workspace-invalidation";
import { addResourceDiagnostics } from "./workspace/resource-diagnostics";
import { homedir } from "node:os";
import type {
  ExecutionCheckoutGitClient,
  PiRpcCommand,
  PiRpcTransport,
  PiRpcTransportStartInput,
  ProviderAuthId,
  SetResourceEnabledInput,
  RuntimeGatewayEventEnvelope,
} from "@pace/core";
import * as piSdk from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  addLocalResource,
  removeLocalResource,
  installPackage,
  removePackage,
  updatePackage,
  setResourceEnabled,
  checkPackageUpdates,
} from "./workspace/resource-management";
import { searchPackageCatalog } from "./workspace/package-catalog";
import { buildConfigInventory } from "./workspace/config";
import {
  createEnvironmentPreflightReader,
  type EnvironmentPreflightReader,
} from "./workspace/environment-preflight";
import {
  createProviderAuthService,
  type ProviderAuthService,
} from "./workspace/provider-auth";
import { listAvailableModelControls } from "./workspace/available-model-controls";
import { createNodeExecutionCheckoutGitClient } from "./workspace/execution-checkout";
import {
  createNodeSessionChangesReader,
  type SessionChangesReader,
} from "./workspace/session-changes";
import {
  createNodeSessionFilesReader,
  type SessionFilesReader,
} from "./workspace/session-files";
import { createNodePiRpcProcess } from "./drivers/pi-rpc";
import { createPiSdkDriver } from "./drivers/pi-sdk-driver";
import {
  createTerminalManager,
  type TerminalManager,
} from "./drivers/terminal";
import {
  createPublicPiSdkRuntimeFactory,
  createPublicPiSdkRuntimeForker,
  createPublicPiSdkRuntimeResumer,
} from "./drivers/pi-sdk-runtime-adapter";
import {
  createRuntimeGatewayService,
  type PiRuntimeDriver,
  type RuntimeGatewayService,
} from "./gateway/runtime-gateway";
import {
  createFileSessionEventJournal,
  resolveDataDir,
  type SessionEventJournal,
} from "./persistence/session-event-journal";
import {
  createFileSessionProjectionStore,
  repairProjectionSessionFiles,
  type PiSessionListItem,
  type PersistedSessionProjection,
  type SessionProjectionStore,
} from "./persistence/session-projection-store";
import {
  lastChatActivityAtFromGatewayEvents,
  lastUserMessageAtFromGatewayEvents,
} from "./persistence/session-list-time";
import {
  annotateSessionPresence,
  buildSessionIndexWithCache,
  createSessionIndexCache,
  loadSessionDetail,
  resolveAgentDir,
  type SessionIndexCache,
} from "./workspace/sessions";
import { resolveChatWorkspaceRoot } from "./workspace/chat-workspace";

export type BackendRpcRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export type BackendRpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

export type BackendRpcEvent = {
  type: "event";
  event: RuntimeGatewayEventEnvelope;
};

export type BackendService = {
  handleRequest(request: BackendRpcRequest): Promise<BackendRpcResponse>;
  onEvent(listener: (event: BackendRpcEvent) => void): () => void;
  dispose(): Promise<void>;
};

export type BackendServiceOptions = {
  agentDir?: string;
  dataDir?: string;
  sessionCache?: SessionIndexCache;
  gitClient?: ExecutionCheckoutGitClient;
  piRpc?: PiRpcTransport;
  runtimeDriver?: PiRuntimeDriver;
  runtimeJournal?: SessionEventJournal;
  sessionProjectionStore?: SessionProjectionStore;
  sessionChangesReader?: SessionChangesReader;
  sessionFilesReader?: SessionFilesReader;
  piSessionListAll?: () => Promise<PiSessionListItem[]>;
  environmentPreflight?: EnvironmentPreflightReader;
  providerAuth?: ProviderAuthService;
  terminalManager?: TerminalManager;
};

export function createBackendService(options: BackendServiceOptions = {}): BackendService {
  // Pi 0.84 lazy-loads OAuth flows through a variable import specifier that
  // bundlers cannot follow; in the bundled backend the runtime chunk path does
  // not exist, so Codex/Anthropic subscription auth fails at request time.
  // Register the statically bundled flows so the lazy loaders resolve locally.
  registerBunOAuthFlows();
  const agentDir = options.agentDir ?? resolveAgentDir();
  const dataDir = options.dataDir ?? resolveDataDir(process.env, homedir());
  const sessionCache = options.sessionCache ?? createSessionIndexCache();
  const gitClient = options.gitClient ?? createNodeExecutionCheckoutGitClient();
  const piRpc = options.piRpc ?? createNodePiRpcProcess();
  const projectionStore =
    options.sessionProjectionStore ??
    createFileSessionProjectionStore({
      dataDir,
    });
  const listeners = new Set<(event: BackendRpcEvent) => void>();
  const invalidation = createWorkspaceInvalidation((payload) => {
    for (const listener of listeners) {
      listener({
        type: "event",
        event: {
          id: `evt-${crypto.randomUUID()}`,
          seq: 0,
          sessionId: payload.sessionIds[0] ?? "",
          piSessionId: "",
          type: "workspace.invalidated",
          ts: new Date().toISOString(),
          payload,
        },
      });
    }
  });
  const gitWatchers = createGitMetadataWatchers((root) => invalidation.invalidateCheckout(root, "git-watch"));
  async function associate(projection: PersistedSessionProjection) {
    const checkout = isRecord(projection.checkout) ? projection.checkout : {};
    const root = optionalString(checkout.executionCheckoutRoot) ?? optionalString(checkout.root);
    if (projection.projectId !== CHAT_PROJECT_ID && root) {
      const checkoutId = invalidation.associate(projection.sessionId, root);
      await gitWatchers.associate(projection.sessionId, checkoutId);
    } else {
      invalidation.remove(projection.sessionId);
      gitWatchers.remove(projection.sessionId);
    }
  }
  // Seed persisted siblings before accepting commands, then track every write
  // through the same store boundary used by creation, resume and deletion.
  const associationsReady = projectionStore.list().then((projections) => {
    return Promise.all(projections.map(associate));
  });
  const sessionProjectionStore: SessionProjectionStore = {
    ...projectionStore,
    async save(projection) {
      await associationsReady;
      await projectionStore.save(projection);
      await associate(projection);
    },
    async remove(sessionId) {
      await associationsReady;
      await projectionStore.remove(sessionId);
      invalidation.remove(sessionId);
      gitWatchers.remove(sessionId);
    },
  };
  const sessionChangesReader =
    options.sessionChangesReader ?? createNodeSessionChangesReader();
  const sessionFilesReader =
    options.sessionFilesReader ?? createNodeSessionFilesReader();
  const environmentPreflight =
    options.environmentPreflight ??
    createEnvironmentPreflightReader({
      agentDir,
      dataDir,
    });
  const providerAuth =
    options.providerAuth ??
    createProviderAuthService({
      agentDir,
    });
  const piSessionListAll =
    options.piSessionListAll ??
    (async () => {
      const sessions = await piSdk.SessionManager.listAll();

      return sessions.map((session) => ({
        id: session.id,
        path: session.path,
      }));
    });
  const runtimeJournal =
    options.runtimeJournal ??
    createFileSessionEventJournal({
      dataDir,
    });
  const sdkOptions = {
    sdk: piSdk,
    async sessionOptionsFor(input: { sessionId: string; cwd: string }) {
      const settingsManager = piSdk.SettingsManager.create(input.cwd, agentDir);
      const resourceLoader = new piSdk.DefaultResourceLoader({
        cwd: input.cwd, agentDir, settingsManager,
      });
      await resourceLoader.reload();
      return { agentDir, settingsManager, resourceLoader };
    },
  };
  const runtimeDriver = options.runtimeDriver ?? createPiSdkDriver({
    runtimeFactory: createPublicPiSdkRuntimeFactory(sdkOptions),
    runtimeForker: createPublicPiSdkRuntimeForker(sdkOptions),
    runtimeResumer: createPublicPiSdkRuntimeResumer(sdkOptions),
  });
  const runtimeGateway = createRuntimeGatewayService({
    driver: runtimeDriver,
    projections: sessionProjectionStore,
    journal: runtimeJournal,
    dataDir,
  });
  const terminalManager = options.terminalManager ?? createTerminalManager();

  runtimeGateway.onEvent((event) => {
    const { payload } = event.event;
    const sessionId = typeof payload.rootSessionId === "string" ? payload.rootSessionId : event.event.sessionId;
    if (payload.phase === "end") {
      if (payload.type === "tool") invalidation.invalidate(sessionId);
      if (payload.type === "turn" || payload.type === "run") invalidation.flush(sessionId);
    }
    for (const listener of listeners) {
      listener(event);
    }
  });

  // Terminal streams are ephemeral UI plumbing, not session truth: they are
  // neither journaled nor sequenced (seq 0), just forwarded as envelopes.
  terminalManager.onEvent((event) => {
    for (const listener of listeners) {
      listener({
        type: "event",
        event: {
          id: `evt-${crypto.randomUUID()}`,
          seq: 0,
          sessionId: event.sessionId,
          piSessionId: event.piSessionId,
          type: event.kind === "output" ? "terminal_output" : "terminal_exit",
          ts: new Date().toISOString(),
          payload:
            event.kind === "output"
              ? { terminalId: event.terminalId, data: event.data, end: event.end }
              : { terminalId: event.terminalId, exitCode: event.exitCode },
        },
      });
    }
  });

  let disposal: Promise<void> | undefined;
  let closing = false;
  return {
    dispose() {
      closing = true;
      disposal ??= (async () => {
        try {
          await runtimeDriver.dispose?.();
        } finally {
          await runtimeGateway.flush();
          await runtimeJournal.flush?.();
          terminalManager.disposeAll();
          gitWatchers.dispose();
          invalidation.dispose();
          listeners.clear();
        }
      })().catch(error => { disposal = undefined; throw error; });
      return disposal;
    },
    async handleRequest(request) {
      try {
        if (closing) throw new Error("Pace backend is closing.");
        await associationsReady;
        return {
          id: request.id,
          result: await dispatchRequest({
            request,
            agentDir,
            sessionCache,
            gitClient,
            piRpc,
            sessionProjectionStore,
            sessionChangesReader,
            sessionFilesReader,
            environmentPreflight,
            providerAuth,
            piSessionListAll,
            runtimeGateway,
            runtimeJournal,
            terminalManager,
            invalidation,
            dataDir,
          }),
        };
      } catch (error) {
        return {
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    onEvent(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

async function dispatchRequest(input: {
  request: BackendRpcRequest;
  agentDir: string;
  sessionCache: SessionIndexCache;
  gitClient: ExecutionCheckoutGitClient;
  piRpc: PiRpcTransport;
  sessionProjectionStore: SessionProjectionStore;
  sessionChangesReader: SessionChangesReader;
  sessionFilesReader: SessionFilesReader;
  environmentPreflight: EnvironmentPreflightReader;
  providerAuth: ProviderAuthService;
  piSessionListAll: () => Promise<PiSessionListItem[]>;
  runtimeGateway: RuntimeGatewayService;
  runtimeJournal: SessionEventJournal;
  terminalManager: TerminalManager;
  invalidation: ReturnType<typeof createWorkspaceInvalidation>;
  dataDir: string;
}) {
  const params = paramsRecord(input.request.params);

  if (isRuntimeGatewayMethod(input.request.method)) {
    if (input.request.method === "stop_run") {
      for (const projection of await input.sessionProjectionStore.list()) {
        if (projection.piSessionId === params.piSessionId) input.invalidation.flush(projection.sessionId);
      }
    }
    const response = await input.runtimeGateway.handleRequest(input.request);

    if (response.error) {
      throw new Error(response.error);
    }

    return response.result;
  }

  switch (input.request.method) {
    case "list_sessions": {
      const [summaries, projections] = await Promise.all([
        buildSessionIndexWithCache(input.agentDir, input.sessionCache, input.dataDir),
        input.sessionProjectionStore.list(),
      ]);

      return annotateSessionPresence(summaries, projections);
    }
    case "get_session_detail":
      return loadSessionDetail(
        input.agentDir,
        requiredString(params.id, "id"),
        input.dataDir,
        input.sessionCache,
      );
    case "list_session_projections":
      return listSessionProjections({
        store: input.sessionProjectionStore,
        piSessionListAll: input.piSessionListAll,
        journal: input.runtimeJournal,
      });
    case "get_session_changes":
      return getSessionChanges({
        sessionId: requiredString(params.sessionId, "sessionId"),
        store: input.sessionProjectionStore,
        reader: input.sessionChangesReader,
      });
    case "checkout_session_branch": {
      const result = await checkoutSessionBranch({
        sessionId: requiredString(params.sessionId, "sessionId"),
        branch: requiredString(params.branch, "branch"),
        store: input.sessionProjectionStore,
        reader: input.sessionChangesReader,
      });
      const sessionId = requiredString(params.sessionId, "sessionId");
      input.invalidation.invalidate(sessionId);
      input.invalidation.flush(sessionId);
      return result;
    }
    case "list_session_directory":
      return listSessionDirectory({
        sessionId: requiredString(params.sessionId, "sessionId"),
        path: optionalString(params.path) ?? "",
        store: input.sessionProjectionStore,
        reader: input.sessionFilesReader,
      });
    case "read_session_file":
      return readSessionFile({
        sessionId: requiredString(params.sessionId, "sessionId"),
        path: requiredString(params.path, "path"),
        store: input.sessionProjectionStore,
        reader: input.sessionFilesReader,
      });
    case "add_local_resource":
      return addLocalResource(input.agentDir, { path: requiredString(params.path, "path"), overwrite: params.overwrite === true });
    case "remove_local_resource":
      return removeLocalResource(input.agentDir, { path: requiredString(params.path, "path") });
    case "install_package":
      return installPackage(input.agentDir, { source: requiredString(params.source, "source") });
    case "remove_package":
      return removePackage(input.agentDir, { source: requiredString(params.source, "source") });
    case "update_package":
      return updatePackage(input.agentDir, { source: params.source === undefined ? undefined : requiredString(params.source, "source") });
    case "search_package_catalog":
      if (params.offset !== undefined && typeof params.offset !== "number") throw new Error("Invalid catalogue offset");
      return searchPackageCatalog({ query: optionalString(params.query), offset: params.offset });
    case "check_package_updates":
      return checkPackageUpdates(input.agentDir);
    case "set_resource_enabled":
      if (typeof params.enabled !== "boolean") throw new Error("enabled must be a boolean");
      return setResourceEnabled(input.agentDir, {
        packageSource: params.packageSource === undefined ? undefined : requiredString(params.packageSource, "packageSource"),
        kind: requiredString(params.kind, "kind") as SetResourceEnabledInput["kind"],
        path: requiredString(params.path, "path"),
        enabled: params.enabled,
      });
    case "get_config_inventory":
      return addResourceDiagnostics(await buildConfigInventory(input.agentDir), input.sessionProjectionStore, input.runtimeJournal);
    case "get_chat_workspace_root":
      return { path: resolveChatWorkspaceRoot(input.dataDir) };
    case "run_environment_preflight":
      return input.environmentPreflight.run();
    case "get_environment_preflight_status":
      return input.environmentPreflight.getStatus();
    case "complete_environment_preflight":
      return input.environmentPreflight.complete();
    case "list_provider_auth_status":
      return input.providerAuth.listStatus();
    case "set_provider_api_key":
      return input.providerAuth.setApiKey(
        requiredString(params.providerId, "providerId") as ProviderAuthId,
        requiredString(params.apiKey, "apiKey"),
      );
    case "remove_provider_auth":
      return input.providerAuth.remove(
        requiredString(params.providerId, "providerId") as ProviderAuthId,
      );
    case "login_provider_oauth":
      return input.providerAuth.loginOAuth(
        requiredString(params.providerId, "providerId") as ProviderAuthId,
      );
    case "logout_provider_auth":
      return input.providerAuth.logout(
        requiredString(params.providerId, "providerId") as ProviderAuthId,
      );
    case "list_available_model_controls":
      return listAvailableModelControls({ agentDir: input.agentDir });
    case "is_git_repository":
      return input.gitClient.isGitRepository(requiredString(params.repoRoot, "repoRoot"));
    case "add_detached_worktree":
      await input.gitClient.addDetachedWorktree(requiredRecord(params.input, "input") as {
        repoRoot: string;
        checkoutRoot: string;
        sessionId: string;
      });
      return null;
    case "start_pi_rpc_runtime":
      await input.piRpc.start(requiredRecord(params.input, "input") as PiRpcTransportStartInput);
      return null;
    case "send_pi_rpc_command":
      return input.piRpc.send(requiredRecord(params.command, "command") as PiRpcCommand);
    case "stop_pi_rpc_runtime":
      await input.piRpc.stop?.();
      return null;
    case "list_terminals":
      return input.terminalManager.list(requiredString(params.sessionId, "sessionId"));
    case "open_terminal":
      return openTerminal({
        sessionId: requiredString(params.sessionId, "sessionId"),
        cols: terminalDimension(params.cols, 80),
        rows: terminalDimension(params.rows, 24),
        store: input.sessionProjectionStore,
        runtimeGateway: input.runtimeGateway,
        terminalManager: input.terminalManager,
      });
    case "attach_terminal":
      return input.terminalManager.attach(requiredString(params.terminalId, "terminalId"));
    case "terminal_input": {
      const data = params.data;

      if (typeof data !== "string") {
        throw new Error("data is required");
      }

      input.terminalManager.write(requiredString(params.terminalId, "terminalId"), data);
      return null;
    }
    case "resize_terminal":
      input.terminalManager.resize(
        requiredString(params.terminalId, "terminalId"),
        terminalDimension(params.cols, 80),
        terminalDimension(params.rows, 24),
      );
      return null;
    case "close_terminal":
      input.terminalManager.close(requiredString(params.terminalId, "terminalId"));
      return null;
    default:
      throw new Error(`Unknown backend RPC method "${input.request.method}".`);
  }
}

async function resolveSessionCheckoutRoots(input: {
  sessionId: string;
  store: SessionProjectionStore;
}) {
  const projection = await input.store.get(input.sessionId);

  if (!projection) {
    throw new Error(`Session projection "${input.sessionId}" was not found.`);
  }

  const checkout = requiredRecord(projection.checkout, "Session checkout");
  const root =
    optionalString(checkout.executionCheckoutRoot) ??
    optionalString(checkout.root);
  const diffRoot = optionalString(checkout.diffRoot) ?? root;

  if (!root || !diffRoot) {
    throw new Error("Session checkout does not include a readable diff root.");
  }

  return { sessionId: input.sessionId, checkoutRoot: root, diffRoot };
}

async function getSessionChanges(input: {
  sessionId: string;
  store: SessionProjectionStore;
  reader: SessionChangesReader;
}) {
  return input.reader.read(await resolveSessionCheckoutRoots(input));
}

async function checkoutSessionBranch(input: {
  sessionId: string;
  branch: string;
  store: SessionProjectionStore;
  reader: SessionChangesReader;
}) {
  return input.reader.checkoutBranch({
    ...(await resolveSessionCheckoutRoots(input)),
    branch: input.branch,
  });
}

// Both Files RPCs take the root from the stored projection only: the renderer
// names a session and a relative path, never a filesystem root.
async function listSessionDirectory(input: {
  sessionId: string;
  path: string;
  store: SessionProjectionStore;
  reader: SessionFilesReader;
}) {
  const { sessionId, diffRoot } = await resolveSessionCheckoutRoots(input);

  return input.reader.listDirectory({ sessionId, diffRoot, path: input.path });
}

async function readSessionFile(input: {
  sessionId: string;
  path: string;
  store: SessionProjectionStore;
  reader: SessionFilesReader;
}) {
  const { sessionId, diffRoot } = await resolveSessionCheckoutRoots(input);

  return input.reader.readFile({ sessionId, diffRoot, path: input.path });
}

async function openTerminal(input: {
  sessionId: string;
  cols: number;
  rows: number;
  store: SessionProjectionStore;
  runtimeGateway: RuntimeGatewayService;
  terminalManager: TerminalManager;
}) {
  const projection = await input.store.get(input.sessionId);

  if (!projection) {
    throw new Error(`Session projection "${input.sessionId}" was not found.`);
  }

  const cwd = await resolveTerminalCwd({
    projection,
    runtimeGateway: input.runtimeGateway,
  });

  return input.terminalManager.create({
    sessionId: input.sessionId,
    piSessionId: projection.piSessionId,
    cwd,
    cols: input.cols,
    rows: input.rows,
  });
}

// Terminals open in the session's execution checkout when one was recorded;
// otherwise they fall back to the cwd of the live runtime snapshot.
async function resolveTerminalCwd(input: {
  projection: PersistedSessionProjection;
  runtimeGateway: RuntimeGatewayService;
}) {
  const checkout = isRecord(input.projection.checkout)
    ? input.projection.checkout
    : undefined;
  const checkoutRoot =
    optionalString(checkout?.executionCheckoutRoot) ??
    optionalString(checkout?.root);

  if (checkoutRoot) {
    return checkoutRoot;
  }

  const snapshot = await input.runtimeGateway.handleRequest({
    id: `open-terminal-${crypto.randomUUID()}`,
    method: "get_runtime_snapshot",
    params: { piSessionId: input.projection.piSessionId },
  });
  const result = isRecord(snapshot.result) ? snapshot.result : undefined;
  const runtimeCwd = snapshot.error ? undefined : optionalString(result?.cwd);

  if (runtimeCwd) {
    return runtimeCwd;
  }

  throw new Error("Session has no checkout or runtime cwd to open a terminal in.");
}

function terminalDimension(value: unknown, fallback: number) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(500, Math.max(1, Math.round(parsed)));
}

async function listSessionProjections(input: {
  store: SessionProjectionStore;
  piSessionListAll: () => Promise<PiSessionListItem[]>;
  journal?: SessionEventJournal;
}) {
  const projections = await input.store.list();

  const projectionsNeedingRepair = projections.filter(
    (projection) => !projection.sessionFile && !projection.sessionFileMissing,
  );

  let nextProjections = projections;

  if (projectionsNeedingRepair.length) {
    nextProjections = repairProjectionSessionFiles(
      projections,
      await input.piSessionListAll(),
    );

    await Promise.all(
      nextProjections
        .filter((projection, index) =>
          projectionChangedForRepair(projections[index], projection),
        )
        .map((projection) => input.store.save(projection)),
    );
  }

  // DF-012: cold list has no in-memory messages; heal updatedAt from journal
  // so sidebar shows last chat time, not last resume wall-clock.
  if (input.journal) {
    nextProjections = await healProjectionListTimesFromJournal({
      projections: nextProjections,
      journal: input.journal,
      store: input.store,
    });
  }

  return nextProjections;
}

async function healProjectionListTimesFromJournal(input: {
  projections: PersistedSessionProjection[];
  journal: SessionEventJournal;
  store: SessionProjectionStore;
}): Promise<PersistedSessionProjection[]> {
  const healed = await Promise.all(
    input.projections.map(async (projection) => {
      try {
        const events = await input.journal.read(projection.piSessionId);
        const activityAt = lastChatActivityAtFromGatewayEvents(events) ?? projection.updatedAt;
        const lastUserMessageAt = projection.lastUserMessageAt ??
          lastUserMessageAtFromGatewayEvents(events) ?? undefined;

        if (activityAt === projection.updatedAt && lastUserMessageAt === projection.lastUserMessageAt) {
          return projection;
        }

        const next = { ...projection, updatedAt: activityAt, lastUserMessageAt };
        await input.store.save(next);
        return next;
      } catch {
        return projection;
      }
    }),
  );

  return healed;
}

function projectionChangedForRepair(
  before: PersistedSessionProjection | undefined,
  after: PersistedSessionProjection,
) {
  return (
    before?.sessionFile !== after.sessionFile ||
    before?.sessionFileMissing !== after.sessionFileMissing
  );
}

function isRuntimeGatewayMethod(method: string) {
  return (
    method === "create_session" ||
    method === "fork_session" ||
    method === "resume_session" ||
    method === "prepare_chat_workspace" ||
    method === "send_prompt" ||
    method === "queue_follow_up" ||
    method === "withdraw_queued_message" ||
    method === "reorder_queued_messages" ||
    method === "steer_run" ||
    method === "stop_run" ||
    method === "send_subagent" ||
    method === "stop_subagent" ||
    method === "configure_model" ||
    method === "resolve_tool_schemas" ||
    method === "archive_session" ||
    method === "rename_session" ||
    method === "delete_session" ||
    method === "get_runtime_snapshot"
  );
}

function paramsRecord(params: unknown) {
  return isRecord(params) ? params : {};
}

function requiredRecord(value: unknown, name: string) {
  if (!isRecord(value)) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

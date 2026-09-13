// @pace/backend — the relocatable backend service: session-log parsing,
// Runtime Gateway dispatch, Pi driver management, config inventory, and
// execution-checkout git work. Hosted in the Electron utilityProcess today and
// a headless server later.

export {
  createBackendService,
  type BackendRpcRequest,
  type BackendRpcResponse,
  type BackendRpcEvent,
  type BackendService,
  type BackendServiceOptions,
} from "./service";

export {
  createEnvironmentPreflightReader,
  summarizeChecks,
  type EnvironmentPreflightReader,
  type EnvironmentPreflightReaderOptions,
} from "./workspace/environment-preflight";

export {
  createProviderAuthService,
  type ProviderAuthService,
  type ProviderAuthServiceOptions,
} from "./workspace/provider-auth";

export {
  createRuntimeGatewayService,
  type RuntimeGatewayDriverEvent,
  type CreateRuntimeSessionInput,
  type SendPromptInput,
  type QueueFollowUpInput,
  type WithdrawQueuedMessageInput,
  type SteerRunInput,
  type StopRunInput,
  type PiRuntimeDriver,
  type RuntimeGatewayBackendEvent,
  type RuntimeGatewayService,
  type RuntimeGatewayServiceOptions,
} from "./gateway/runtime-gateway";

export {
  createPiRpcProcessDriver,
  type PiRpcProcessDriverOptions,
} from "./drivers/pi-rpc-driver";

export {
  PiSdkDriverUnsupportedError,
  createPiSdkDriver,
  type PiSdkDriverOptions,
  type PiSdkPackageModule,
  type PiSdkQueuedMessage,
  type PiSdkRuntimeEvent,
  type PiSdkRuntimeFactory,
  type PiSdkSessionRuntime,
  type PiSdkSnapshotPatch,
} from "./drivers/pi-sdk-driver";

export {
  type PersistedSessionProjection,
  type SessionProjectionStore,
} from "./persistence/session-projection-store";

export {
  createNodeSessionChangesReader,
  type ReadSessionChangesInput,
  type CheckoutSessionBranchInput,
  type SessionChangesReader,
} from "./workspace/session-changes";

export {
  createNodeSessionFilesReader,
  type ListSessionDirectoryInput,
  type ReadSessionFileInput,
  type SessionFilesReader,
  type SessionFilesReaderOptions,
} from "./workspace/session-files";

export { migrateDataDir } from "./persistence/session-event-journal";

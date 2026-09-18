// Provider auth service — list/set/remove API keys and OAuth login/logout
// through Pi ModelRuntime (same auth.json as preflight and runtime). Pi 0.84
// moved auth orchestration from AuthStorage into ModelRuntime; credentials
// persist to auth.json and the runtime snapshot stays in sync.

import { join } from "node:path";
import { spawn } from "node:child_process";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  PROVIDER_DISPLAY_OVERRIDES,
  sortProvidersForDisplay,
  type ProviderAuthId,
  type ProviderAuthMode,
  type ProviderAuthStatusItem,
  type ProviderAuthStatusReport,
} from "@pace/core";

type RuntimeInstance = Awaited<ReturnType<typeof ModelRuntime.create>>;
type AuthInteraction = Parameters<RuntimeInstance["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];
type AuthEvent = Parameters<AuthInteraction["notify"]>[0];
type StoredCredential = ReturnType<typeof readStoredCredential>;
type RuntimeProvider = {
  id: string;
  name: string;
  auth: { apiKey?: unknown; oauth?: unknown };
};

/** Minimal runtime surface so tests can substitute a stub. */
export type ProviderAuthRuntime = Pick<
  RuntimeInstance,
  "getProviderAuthStatus" | "login" | "logout" | "refresh"
> & {
  getProviders(): readonly RuntimeProvider[];
};

export type ProviderAuthService = {
  listStatus(): Promise<ProviderAuthStatusReport>;
  setApiKey(providerId: ProviderAuthId, apiKey: string): Promise<ProviderAuthStatusReport>;
  remove(providerId: ProviderAuthId): Promise<ProviderAuthStatusReport>;
  loginOAuth(providerId: ProviderAuthId): Promise<ProviderAuthStatusReport>;
  logout(providerId: ProviderAuthId): Promise<ProviderAuthStatusReport>;
};

export type ProviderAuthServiceOptions = {
  agentDir: string;
  openExternalUrl?: (url: string) => void | Promise<void>;
  /** Override runtime creation for tests. */
  createRuntime?: () => Promise<ProviderAuthRuntime>;
};

function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) {
    return "••••";
  }

  return `…${trimmed.slice(-4)}`;
}

function openUrlDefault(url: string) {
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function modeFromCredential(credential: StoredCredential): ProviderAuthMode {
  if (!credential) {
    return "none";
  }

  if (credential.type === "api_key") {
    return "api_key";
  }

  if (credential.type === "oauth") {
    return "oauth";
  }

  return "none";
}

function keyHintFromCredential(credential: StoredCredential): string | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.type === "api_key" && typeof credential.key === "string") {
    return maskKey(credential.key);
  }

  if (credential.type === "oauth") {
    const access = typeof credential.access === "string" ? credential.access : "";
    if (access) {
      return maskKey(access);
    }
  }

  return undefined;
}

function findRuntimeProvider(runtime: ProviderAuthRuntime, providerId: string) {
  const provider = runtime.getProviders().find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`Unknown provider "${providerId}".`);
  }

  return provider;
}

/** A prompt that never settles: browser/device-code flows race a manual-code
 * prompt against the callback server. Pace has no paste box, so we pend and
 * let the browser callback (or device-code poll) win. */
function pendPrompt(): Promise<string> {
  return new Promise<string>(() => {});
}

export function createProviderAuthService(
  options: ProviderAuthServiceOptions,
): ProviderAuthService {
  const authPath = join(options.agentDir, "auth.json");
  const modelsPath = join(options.agentDir, "models.json");
  const openExternal = options.openExternalUrl ?? openUrlDefault;
  const createRuntime =
    options.createRuntime ??
    (() =>
      ModelRuntime.create({
        authPath,
        modelsPath,
        allowModelNetwork: false,
      }));

  let runtimePromise: Promise<ProviderAuthRuntime> | null = null;
  const getRuntime = () => (runtimePromise ??= createRuntime());

  const listStatus = async (): Promise<ProviderAuthStatusReport> => {
    const runtime = await getRuntime();
    // Re-read auth.json so logins done in the Pi TUI while Pace is open show up.
    await runtime.refresh({ allowNetwork: false }).catch(() => {});

    const providers = sortProvidersForDisplay(
      runtime.getProviders().map((provider) => {
        const credential = readStoredCredential(provider.id, authPath);
        const mode = modeFromCredential(credential);
        const status = runtime.getProviderAuthStatus(provider.id);
        const keyHint = keyHintFromCredential(credential);

        return {
          id: provider.id,
          label: PROVIDER_DISPLAY_OVERRIDES[provider.id] ?? provider.name,
          supportsApiKey: Boolean(provider.auth.apiKey),
          supportsOAuth: Boolean(provider.auth.oauth),
          mode,
          configured: status.configured || mode !== "none",
          ...(keyHint ? { keyHint } : {}),
          ...(status.label ? { statusLabel: status.label } : {}),
        };
      }),
    );

    return {
      agentDir: options.agentDir,
      authPath,
      providers,
      configuredCount: providers.filter((provider) => provider.configured).length,
    };
  };

  return {
    listStatus,

    async setApiKey(providerId, apiKey) {
      const runtime = await getRuntime();
      const provider = findRuntimeProvider(runtime, providerId);

      if (!provider.auth.apiKey) {
        throw new Error(`Provider "${providerId}" does not support API keys.`);
      }

      const trimmed = apiKey.trim();
      if (!trimmed) {
        throw new Error("API key must not be empty.");
      }
      // API-key "login" is a stored-credential write: the provider's apiKey
      // login prompt returns the key, which ModelRuntime persists to auth.json.
      await runtime.login(providerId, "api_key", {
        prompt: (prompt: AuthPrompt) =>
          prompt.type === "secret" ? Promise.resolve(trimmed) : pendPrompt(),
        notify: () => {},
      });
      return listStatus();
    },

    async remove(providerId) {
      const runtime = await getRuntime();
      findRuntimeProvider(runtime, providerId);
      await runtime.logout(providerId);
      return listStatus();
    },

    async loginOAuth(providerId) {
      const runtime = await getRuntime();
      const provider = findRuntimeProvider(runtime, providerId);

      if (!provider.auth.oauth) {
        throw new Error(`Provider "${providerId}" does not support subscription login.`);
      }
      await runtime.login(providerId, "oauth", {
        prompt: (prompt: AuthPrompt) => {
          // Codex asks browser vs device-code; GUI always takes the browser flow.
          if (prompt.type === "select") {
            const browser = prompt.options.find((option) => option.id === "browser");
            if (browser) {
              return Promise.resolve(browser.id);
            }
          }

          return pendPrompt();
        },
        notify: (event: AuthEvent) => {
          if (event.type === "auth_url") {
            void openExternal(event.url);
          } else if (event.type === "device_code") {
            void openExternal(event.verificationUri);
          }
        },
      });

      return listStatus();
    },

    async logout(providerId) {
      const runtime = await getRuntime();
      findRuntimeProvider(runtime, providerId);
      await runtime.logout(providerId);
      return listStatus();
    },
  };
}

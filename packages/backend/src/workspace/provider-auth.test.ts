import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createProviderAuthService,
  type ProviderAuthRuntime,
} from "./provider-auth";

async function tempAgentDir() {
  return mkdtemp(join(tmpdir(), "pigui-provider-auth-"));
}

describe("provider auth service", () => {
  it("lists every runtime provider including Radius and Codex auth shapes", async () => {
    const agentDir = await tempAgentDir();
    const service = createProviderAuthService({ agentDir });
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });

    const report = await service.listStatus();

    expect(report.providers).toHaveLength(runtime.getProviders().length);
    expect(report.providers.find((provider) => provider.id === "radius")).toMatchObject({
      supportsApiKey: true,
      supportsOAuth: true,
    });
    expect(report.providers.find((provider) => provider.id === "openai-codex")).toMatchObject({
      supportsApiKey: false,
      supportsOAuth: true,
    });
  });

  it("reuses openai-codex OAuth already stored in Pi auth.json", async () => {
    const agentDir = await tempAgentDir();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "sk-codex-access-ae1d",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "acct_1",
        },
      }),
      "utf8",
    );
    const service = createProviderAuthService({ agentDir });

    const report = await service.listStatus();
    const codex = report.providers.find((provider) => provider.id === "openai-codex");

    expect(codex).toMatchObject({
      mode: "oauth",
      configured: true,
      supportsOAuth: true,
      supportsApiKey: false,
      keyHint: "…ae1d",
    });
    expect(report.configuredCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain("sk-codex-access-ae1d");
  });

  it("sets an API key and returns a masked hint without the full secret", async () => {
    const agentDir = await tempAgentDir();
    const service = createProviderAuthService({ agentDir });

    const report = await service.setApiKey("deepseek", "sk-secret-key-ae1d");

    const deepseek = report.providers.find((provider) => provider.id === "deepseek");
    expect(deepseek).toMatchObject({
      mode: "api_key",
      configured: true,
      keyHint: "…ae1d",
    });
    expect(JSON.stringify(report)).not.toContain("sk-secret-key-ae1d");

    const onDisk = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as {
      deepseek: { type: string; key: string };
    };
    expect(onDisk.deepseek).toEqual({ type: "api_key", key: "sk-secret-key-ae1d" });
  });

  it("removes a provider credential", async () => {
    const agentDir = await tempAgentDir();
    const service = createProviderAuthService({ agentDir });
    await service.setApiKey("openai", "sk-openai-1234");

    const report = await service.remove("openai");

    expect(report.configuredCount).toBe(0);
    expect(report.providers.find((provider) => provider.id === "openai")?.mode).toBe(
      "none",
    );
  });

  it("rejects empty API keys", async () => {
    const agentDir = await tempAgentDir();
    const service = createProviderAuthService({ agentDir });

    await expect(service.setApiKey("openai", "   ")).rejects.toThrow(/empty/i);
  });

  it("rejects API keys when Pi reports the provider as oauth-only", async () => {
    const agentDir = await tempAgentDir();
    const service = createProviderAuthService({ agentDir });

    await expect(service.setApiKey("openai-codex", "sk-not-a-key")).rejects.toThrow(
      /does not support API keys/i,
    );
  });

  it("defaults Codex subscription login to the browser OAuth method", async () => {
    const agentDir = await tempAgentDir();
    let selected: string | undefined;
    const runtime: ProviderAuthRuntime = {
      getProviderAuthStatus: () => ({ configured: false }),
      getProviders: () => [
        { id: "openai-codex", name: "OpenAI Codex", auth: { oauth: {} } },
      ],
      async login(_providerId, _type, interaction) {
        selected = await interaction.prompt({
          type: "select",
          message: "Select OpenAI Codex login method:",
          options: [
            { id: "browser", label: "Browser login (default)" },
            { id: "device_code", label: "Device code login (headless)" },
          ],
        });
        return { type: "oauth", access: "a", refresh: "r", expires: 0 };
      },
      async logout() {},
      async refresh() {
        return { aborted: false, errors: new Map() };
      },
    };
    const service = createProviderAuthService({
      agentDir,
      createRuntime: async () => runtime,
    });

    await service.loginOAuth("openai-codex");

    expect(selected).toBe("browser");
  });

  it("reuses xai OAuth already stored in Pi auth.json", async () => {
    const agentDir = await tempAgentDir();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "xai-access-ae1d",
          refresh: "xai-refresh",
          expires: Date.now() + 60_000,
        },
      }),
      "utf8",
    );
    const service = createProviderAuthService({ agentDir });

    const report = await service.listStatus();
    const xai = report.providers.find((provider) => provider.id === "xai");

    expect(xai).toMatchObject({
      mode: "oauth",
      configured: true,
      supportsOAuth: true,
      supportsApiKey: true,
      keyHint: "…ae1d",
    });
    expect(JSON.stringify(report)).not.toContain("xai-access-ae1d");
  });

  it("opens the xAI device-code verification URI on subscription login", async () => {
    const agentDir = await tempAgentDir();
    const opened: string[] = [];
    const runtime: ProviderAuthRuntime = {
      getProviderAuthStatus: () => ({ configured: false }),
      getProviders: () => [
        { id: "xai", name: "xAI", auth: { apiKey: {}, oauth: {} } },
      ],
      async login(_providerId, _type, interaction) {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://auth.x.ai/activate",
          intervalSeconds: 5,
          expiresInSeconds: 600,
        });
        return { type: "oauth", access: "a", refresh: "r", expires: 0 };
      },
      async logout() {},
      async refresh() {
        return { aborted: false, errors: new Map() };
      },
    };
    const service = createProviderAuthService({
      agentDir,
      openExternalUrl: (url) => {
        opened.push(url);
      },
      createRuntime: async () => runtime,
    });

    await service.loginOAuth("xai");

    expect(opened).toEqual(["https://auth.x.ai/activate"]);
  });
});

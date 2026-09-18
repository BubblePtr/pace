import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "@/pages/settings";
import { AppFrame } from "@/app/app-shell";
import {
  getVisibleModels,
  saveVisibleModels,
} from "@/entities/model/visible-models";
import { resetUpdateStatusStore } from "@/entities/update/use-update-status";
import type { PaceRendererApi } from "@/shared/runtime";
import type { UpdateStatus } from "@/shared/update-protocol";

const providerAuthStatus = {
  agentDir: "/agent",
  authPath: "/agent/auth.json",
  configuredCount: 1,
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      supportsApiKey: true,
      supportsOAuth: true,
      mode: "api_key",
      configured: true,
      keyHint: "…dev1",
    },
    {
      id: "xai",
      label: "Grok (xAI)",
      supportsApiKey: true,
      supportsOAuth: true,
      mode: "none",
      configured: false,
    },
    {
      // Label does not contain the id, so an id query cannot pass via label.
      id: "github-copilot",
      label: "GitHub Copilot",
      supportsApiKey: true,
      supportsOAuth: true,
      mode: "none",
      configured: false,
    },
  ],
};

const modelControls = {
  models: [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      thinkingLevels: ["off", "high"],
    },
    {
      provider: "xai",
      modelId: "grok-4",
      name: "Grok 4",
      thinkingLevels: ["off", "high"],
    },
    {
      provider: "xai",
      modelId: "grok-4-fast",
      name: "Grok 4 Fast",
      thinkingLevels: ["off", "high"],
    },
    // Catalog providers are a superset of the auth providers.
    {
      provider: "moonshot",
      modelId: "kimi-k3",
      name: "Kimi K3",
      thinkingLevels: ["off"],
    },
  ],
  selected: {
    provider: "xai",
    modelId: "grok-4",
    thinkingLevel: "high",
  },
};

const disabledUpdateStatus: UpdateStatus = {
  state: "disabled",
  currentVersion: "0.0.1",
  reason: "Updates are only available in the packaged desktop app.",
};

function renderSettings(
  path = "/usage?settings=models",
  updateStatus: UpdateStatus = disabledUpdateStatus,
) {
  const updateListeners = new Set<(status: UpdateStatus) => void>();
  const invoke = vi.fn(async (command: string) => {
    if (
      command === "list_provider_auth_status" ||
      command === "set_provider_api_key"
    ) {
      return providerAuthStatus;
    }

    if (command === "list_available_model_controls") {
      return modelControls;
    }

    if (command === "get_chat_workspace_root") {
      return { path: "/tmp/pigui-dev/chats" };
    }

    if (command === "reveal_project_in_finder") {
      return undefined;
    }

    if (
      command === "update:status" ||
      command === "update:check" ||
      command === "update:install"
    ) {
      return updateStatus;
    }

    throw new Error(`unexpected backend command ${command}`);
  });

  window.pace = {
    invoke: invoke as unknown as PaceRendererApi["invoke"],
    onBackendEvent: vi.fn(() => vi.fn()),
    onBrowserEvent: vi.fn(() => vi.fn()),
    onUpdateEvent: vi.fn((listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    }),
    onWindowFocusChanged: vi.fn(() => vi.fn()),
    onNavigateRequest: vi.fn(() => vi.fn()),
  };

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AppFrame>
          <textarea aria-label="Session draft" defaultValue="Keep my draft" />
        </AppFrame>
        <SettingsDialog />
      </>
    ),
  });
  const usageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/usage",
    component: () => null,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: rootRoute.addChildren([usageRoute]),
  });

  return {
    ...render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
    emitUpdate: (status: UpdateStatus) => {
      act(() => {
        for (const listener of updateListeners) listener(status);
      });
    },
    countCalls: (command: string) =>
      invoke.mock.calls.filter(([called]) => called === command).length,
  };
}

async function findModelsSection() {
  return screen.findByRole("region", { name: "Models" });
}

beforeEach(() => {
  resetUpdateStatusStore();
});

describe("Settings — visible models", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("lists the available models grouped by provider, all visible by default", async () => {
    renderSettings();

    const section = await findModelsSection();
    const groups = await within(section).findAllByRole("group");

    expect(groups).toHaveLength(3);
    expect(
      within(section).getByRole("group", { name: "Anthropic models" }),
    ).toBe(groups[0]);
    expect(
      within(section).getByRole("group", { name: "Grok (xAI) models" }),
    ).toBe(groups[1]);
    // A catalog provider without an auth entry falls back to its raw id.
    expect(
      within(section).getByRole("group", { name: "moonshot models" }),
    ).toBe(groups[2]);
    for (const name of [
      "Claude Sonnet 4",
      "Grok 4",
      "Grok 4 Fast",
      "Kimi K3",
    ]) {
      expect(within(section).getByRole("checkbox", { name })).toBeChecked();
    }
  });

  it("persists the models left visible after unchecking one", async () => {
    const user = userEvent.setup();

    renderSettings();

    const section = await findModelsSection();

    await user.click(
      await within(section).findByRole("checkbox", { name: "Grok 4 Fast" }),
    );

    await waitFor(() => {
      expect(getVisibleModels()).toEqual([
        { provider: "anthropic", modelId: "claude-sonnet-4" },
        { provider: "moonshot", modelId: "kimi-k3" },
        { provider: "xai", modelId: "grok-4" },
      ]);
    });
    expect(
      within(section).getByRole("checkbox", { name: "Grok 4 Fast" }),
    ).not.toBeChecked();
  });

  it("drops stored models that have left the catalog when the set changes", async () => {
    const user = userEvent.setup();

    saveVisibleModels([
      { provider: "xai", modelId: "grok-4" },
      { provider: "xai", modelId: "retired-model" },
    ]);
    renderSettings();

    const section = await findModelsSection();

    await user.click(
      await within(section).findByRole("checkbox", { name: "Claude Sonnet 4" }),
    );

    await waitFor(() => {
      expect(getVisibleModels()).toEqual([
        { provider: "xai", modelId: "grok-4" },
        { provider: "anthropic", modelId: "claude-sonnet-4" },
      ]);
    });
  });

  it("refetches the model catalog after provider credentials change", async () => {
    const user = userEvent.setup();
    const { countCalls } = renderSettings();

    await findModelsSection();
    await waitFor(() => {
      expect(countCalls("list_available_model_controls")).toBe(1);
    });

    await user.click(screen.getByRole("button", { name: "Providers" }));
    await user.click(screen.getByRole("button", { name: "API Key" }));

    const card = await screen.findByTestId("provider-api-key-anthropic");

    await user.type(
      within(card).getByPlaceholderText("Paste API key"),
      "sk-test",
    );
    await user.click(within(card).getByRole("button", { name: "Replace key" }));

    await waitFor(() => {
      expect(countCalls("list_available_model_controls")).toBe(2);
    });
  });

  it("opens directly to Models and switches sections without losing an API key draft", async () => {
    const user = userEvent.setup();
    renderSettings();
    await findModelsSection();
    expect(
      screen.queryByRole("region", { name: "Providers" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Providers" }));
    await user.click(screen.getByRole("button", { name: "API Key" }));
    const card = await screen.findByTestId("provider-api-key-anthropic");
    await user.type(
      within(card).getByPlaceholderText("Paste API key"),
      "sk-unsaved",
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    await findModelsSection();
    await user.click(screen.getByRole("button", { name: "Providers" }));
    expect(within(card).getByPlaceholderText("Paste API key")).toHaveValue(
      "sk-unsaved",
    );
  });
});

describe("Settings — chats", () => {
  it("does not query the chat workspace root until the Chats section is open", async () => {
    const user = userEvent.setup();
    const { countCalls } = renderSettings();

    await findModelsSection();
    expect(countCalls("get_chat_workspace_root")).toBe(0);

    await user.click(screen.getByRole("button", { name: "Chats" }));

    await waitFor(() => {
      expect(countCalls("get_chat_workspace_root")).toBe(1);
    });
  });

  it("shows the chat workspace root and opens the folder", async () => {
    const user = userEvent.setup();
    const { countCalls } = renderSettings("/usage?settings=chats");

    const section = await screen.findByTestId("settings-chats");

    expect(within(section).getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(await within(section).findByText("/tmp/pigui-dev/chats")).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "Open folder" }));

    expect(countCalls("reveal_project_in_finder")).toBe(1);
    expect(window.pace!.invoke).toHaveBeenCalledWith("reveal_project_in_finder", {
      path: "/tmp/pigui-dev/chats",
      ensure: true,
    });
  });
});

describe("Settings — about and updates", () => {
  it.each([false, true])(
    "keeps the update indicator in sync while browsing another section (compact: %s)",
    async (compact) => {
      const originalMatchMedia = window.matchMedia;
      const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
        ...originalMatchMedia(query),
        matches: query === "(max-width: 640px)" && compact,
      }));
      try {
        const { emitUpdate, countCalls } = renderSettings("/usage?settings=models", {
          state: "idle",
          currentVersion: "0.0.1",
        });
        const navigation = await screen.findByRole("navigation", { name: "Settings sections" });
        const about = within(navigation).getByRole("button", {
          name: compact ? "About" : "About & Updates",
        });
        await findModelsSection();
        await waitFor(() => expect(countCalls("update:status")).toBe(1));
        expect(within(about).queryByText("Update")).not.toBeInTheDocument();
        expect(within(about).queryByText("Ready")).not.toBeInTheDocument();

        emitUpdate({ state: "available", currentVersion: "0.0.1", availableVersion: "0.0.2" });
        expect(within(about).getByText("Update")).toBeVisible();
        expect(screen.queryByRole("region", { name: "About & Updates" })).not.toBeInTheDocument();

        emitUpdate({ state: "downloading", currentVersion: "0.0.1", progressPercent: 42 });
        expect(within(about).getByText("Update")).toBeVisible();

        emitUpdate({ state: "ready", currentVersion: "0.0.1", availableVersion: "0.0.2" });
        expect(within(about).queryByText("Update")).not.toBeInTheDocument();
        expect(within(about).getByText("Ready")).toBeVisible();
        await userEvent.click(about);
        const section = await screen.findByRole("region", { name: "About & Updates" });
        expect(within(section).getByRole("button", { name: "Restart to update" })).toBeEnabled();
        expect(within(about).getByText("Ready")).toBeVisible();

        emitUpdate({ state: "idle", currentVersion: "0.0.2" });
        expect(within(about).queryByText("Update")).not.toBeInTheDocument();
        expect(within(about).queryByText("Ready")).not.toBeInTheDocument();
        expect(within(section).queryByRole("button", { name: "Restart to update" })).not.toBeInTheDocument();
      } finally {
        matchMedia.mockRestore();
      }
    },
  );

  async function findAboutSection() {
    await userEvent.click(
      await screen.findByRole("button", { name: /^About & Updates/ }),
    );
    return screen.findByTestId("settings-about");
  }

  it("shows a cached ready update when Settings opens after a background download", async () => {
    const { emitUpdate, countCalls } = renderSettings("/usage", {
      state: "idle",
      currentVersion: "0.0.1",
    });
    const settings = await screen.findByRole("button", { name: "Settings" });
    await waitFor(() => expect(countCalls("update:status")).toBe(1));
    emitUpdate({ state: "ready", currentVersion: "0.0.1", availableVersion: "0.0.2" });

    await userEvent.click(settings);
    const navigation = await screen.findByRole("navigation", { name: "Settings sections" });
    const about = within(navigation).getByRole("button", { name: /^About & Updates/ });
    expect(within(about).getByText("Ready")).toBeVisible();
    expect(screen.getByRole("region", { name: "Providers" })).toBeVisible();
    expect(countCalls("update:status")).toBe(1);
  });

  it("shows the current version and a disabled check button when updates are disabled", async () => {
    renderSettings();

    const section = await findAboutSection();

    expect(await within(section).findByText(/0\.0\.1/)).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Check for updates" }),
    ).toBeDisabled();
    expect(
      within(section).queryByRole("button", { name: "Restart to update" }),
    ).not.toBeInTheDocument();
  });

  it("keeps restart hidden while an update is available", async () => {
    renderSettings("/usage?settings=about", {
      state: "available",
      currentVersion: "0.0.1",
      availableVersion: "0.0.2",
    });

    const section = await findAboutSection();

    expect(await within(section).findByText(/0\.0\.1/)).toBeInTheDocument();
    expect(within(section).getByText(/0\.0\.2/)).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Check for updates" }),
    ).toBeEnabled();
    expect(
      within(section).queryByRole("button", { name: "Restart to update" }),
    ).not.toBeInTheDocument();
  });

  it("shows restart to update only when an update is ready", async () => {
    renderSettings("/usage?settings=about", {
      state: "ready",
      currentVersion: "0.0.1",
      availableVersion: "0.0.2",
    });

    const section = await findAboutSection();

    expect(
      await within(section).findByRole("button", { name: "Restart to update" }),
    ).toBeEnabled();
    expect(
      within(section).getByRole("button", { name: "Check for updates" }),
    ).toBeEnabled();
  });

  it("surfaces an update error without offering restart", async () => {
    renderSettings("/usage?settings=about", {
      state: "error",
      currentVersion: "0.0.1",
      message: "GitHub releases timed out",
    });

    const section = await findAboutSection();

    expect(
      await within(section).findByText("GitHub releases timed out"),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Check for updates" }),
    ).toBeEnabled();
    expect(
      within(section).queryByRole("button", { name: "Restart to update" }),
    ).not.toBeInTheDocument();
  });
});

describe("Settings — changelog", () => {
  it("uses compact navigation labels and keeps every section accessible on narrow screens", async () => {
    const originalMatchMedia = window.matchMedia;
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...originalMatchMedia(query),
      matches: query === "(max-width: 640px)",
    }));
    try {
      renderSettings("/usage?settings=changelog");
      const navigation = await screen.findByRole("navigation", { name: "Settings sections" });
      await userEvent.click(within(navigation).getByRole("button", { name: "About" }));
      expect(await screen.findByRole("region", { name: "About & Updates" })).toBeVisible();
      await userEvent.click(within(navigation).getByRole("button", { name: "Changelog" }));
      expect(await screen.findByRole("region", { name: "Changelog" })).toBeVisible();
    } finally {
      matchMedia.mockRestore();
    }
  });

  it("opens the release timeline directly from the settings query", async () => {
    renderSettings("/usage?settings=changelog");

    const section = await screen.findByRole("region", { name: "Changelog" });
    expect(within(section).getByRole("heading", { name: "v0.0.1" })).toBeVisible();
    expect(within(section).getByText("September 6, 2026")).toBeVisible();
    expect(within(section).getByText("Projects and sessions")).toBeVisible();
    expect(within(section).getByText("Chat and trajectory")).toBeVisible();
    expect(within(section).getByText("Browser and terminal")).toBeVisible();
    expect(within(section).getByText("Providers and models")).toBeVisible();
    const firstRelease = within(section).getByRole("article", { name: "v0.0.1" });
    expect(within(firstRelease).getByRole("link", { name: /View release on GitHub/ }))
      .toHaveAttribute("href", "https://github.com/BubblePtr/pace/releases/tag/v0.0.1");
  });

  it("switches to the changelog without losing the route or an unsaved settings draft", async () => {
    const user = userEvent.setup();
    const { router } = renderSettings("/usage?range=week&settings=providers#totals");
    await user.click(await screen.findByRole("button", { name: "API Key" }));
    const input = within(await screen.findByTestId("provider-api-key-anthropic"))
      .getByPlaceholderText("Paste API key");
    await user.type(input, "sk-unsaved");
    await user.click(screen.getByRole("button", { name: "Changelog" }));

    expect(await screen.findByRole("region", { name: "Changelog" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/usage");
    expect(router.state.location.search).toMatchObject({ range: "week", settings: "changelog" });
    expect(router.state.location.hash).toBe("totals");
    await user.click(screen.getByRole("button", { name: "Providers" }));
    expect(input).toHaveValue("sk-unsaved");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.href).toBe("/usage?range=week#totals"));
  });
});

describe("Settings — provider API keys", () => {
  it("filters API key cards by label or id", async () => {
    const user = userEvent.setup();
    renderSettings("/usage?settings=providers");

    await user.click(await screen.findByRole("button", { name: "API Key" }));
    expect(await screen.findByTestId("provider-api-key-anthropic")).toBeVisible();
    expect(screen.getByTestId("provider-api-key-xai")).toBeVisible();
    expect(screen.getByTestId("provider-api-key-github-copilot")).toBeVisible();

    await user.type(screen.getByPlaceholderText(/filter/i), "Grok");

    expect(screen.getByTestId("provider-api-key-xai")).toBeVisible();
    expect(screen.queryByTestId("provider-api-key-anthropic")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("provider-api-key-github-copilot"),
    ).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText(/filter/i));
    await user.type(screen.getByPlaceholderText(/filter/i), "github-copilot");

    expect(screen.getByTestId("provider-api-key-github-copilot")).toBeVisible();
    expect(screen.queryByTestId("provider-api-key-anthropic")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-api-key-xai")).not.toBeInTheDocument();
  });
});

describe("Settings dialog navigation", () => {
  it("opens over the current page and restores its route, draft and trigger on close", async () => {
    const user = userEvent.setup();
    const { router, countCalls } = renderSettings("/usage?range=week#totals");
    const trigger = await screen.findByRole("button", { name: "Settings" });
    const draft = screen.getByRole("textbox", { name: "Session draft" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(countCalls("list_provider_auth_status")).toBe(0);
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(router.state.location.pathname).toBe("/usage");
    expect(router.state.location.search).toMatchObject({
      range: "week",
      settings: "providers",
    });
    expect(router.state.location.hash).toBe("totals");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(router.state.location.href).toBe("/usage?range=week#totals");
    expect(screen.getByRole("textbox", { name: "Session draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep my draft");
    expect(trigger).toHaveFocus();
  });

  it("closes with Escape", async () => {
    const user = userEvent.setup();
    const { router } = renderSettings();
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("button", { name: "Models" }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/usage");
  });
});

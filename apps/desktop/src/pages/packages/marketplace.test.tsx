import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConfigInventory, PackageCatalogPage } from "@pace/core";
import { invoke } from "@/shared/runtime";
import { Marketplace } from "./marketplace";
import { PackageManagement } from "./resources";

vi.mock("@/shared/runtime", () => ({ invoke: vi.fn() }));
const resource = {
  kind: "skill" as const,
  name: "review changes",
  path: "/kit/review/SKILL.md",
  enabled: true,
  origin: "package" as const,
  scope: "user" as const,
  packageSource: "npm:@team/pi-review@1.0.0",
};
const inventory: ConfigInventory = {
  packages: [
    {
      source: resource.packageSource,
      name: "@team/pi-review",
      version: "1.0.0",
      installedPath: "/kit",
      scope: "user",
      filtered: false,
      resources: [resource],
    },
  ],
  extensions: [],
  skills: [resource],
  themes: [],
  promptTemplates: [],
};
const catalog: PackageCatalogPage = {
  total: 1,
  nextOffset: null,
  packages: [
    {
      source: "npm:@team/pi-review",
      name: "@team/pi-review",
      version: "2.0.0",
      description: "Reviews your changes",
      author: "Team",
      kinds: ["skill"],
      typesKnown: true,
    },
  ],
};

function view(data = inventory) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderView = (value: ConfigInventory) => (
    <QueryClientProvider client={client}>
      <PackageManagement inventory={value}>
        <Marketplace
          inventory={value}
          onEnvironmentCheck={() => {}}
          onRefresh={() => {}}
          refreshing={false}
        />
      </PackageManagement>
    </QueryClientProvider>
  );
  return { ...render(renderView(data)), renderView };
}
beforeEach(() => {
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) =>
      command === "search_package_catalog"
        ? catalog
        : command === "check_package_updates"
          ? { updates: [] }
          : { progress: [] },
    );
});

it("keeps local packages and diagnostics manageable when discovery is offline", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "search_package_catalog") throw new Error("offline");
    return { updates: [] };
  });
  view();
  expect(
    await screen.findByText(/catalogue couldn’t load/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Installed · 1/ }));
  fireEvent.click(screen.getByRole("button", { name: "View Review" }));
  const dialog = screen.getByRole("dialog", { name: "Review package details" });
  expect(
    within(dialog).getByText("Installed version · 1.0.0"),
  ).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Resources" }));
  fireEvent.click(
    within(dialog).getByRole("switch", { name: "Enable review changes" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_resource_enabled", {
      path: resource.path,
      kind: "skill",
      packageSource: resource.packageSource,
      enabled: false,
    }),
  );
});

it("matches pinned scoped npm packages without replacing the registered source", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "search_package_catalog"
      ? catalog
      : command === "check_package_updates"
        ? {
            updates: [
              { source: resource.packageSource, scope: "user", type: "npm" },
            ],
          }
        : { progress: [] },
  );
  view();
  const update = await screen.findByRole("button", { name: "Update Review" });
  expect(
    screen.queryByRole("button", { name: "Install Review" }),
  ).not.toBeInTheDocument();
  fireEvent.click(update);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("update_package", {
      source: resource.packageSource,
    }),
  );
});

it("uses refreshed inventory in an open detail instead of retaining stale resource toggles", async () => {
  const { rerender, renderView } = view();
  fireEvent.click(await screen.findByRole("button", { name: "View Review" }));
  fireEvent.click(screen.getByRole("button", { name: "Resources" }));
  const toggle = screen.getByRole("switch", { name: "Enable review changes" });
  expect(toggle).toBeChecked();
  rerender(
    renderView({
      ...inventory,
      packages: [
        {
          ...inventory.packages[0],
          resources: [{ ...resource, enabled: false }],
        },
      ],
      skills: [{ ...resource, enabled: false }],
    }),
  );
  expect(
    screen.getByRole("switch", { name: "Enable review changes" }),
  ).not.toBeChecked();
});

it("does not claim updates are current when the check failed", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "check_package_updates")
      throw new Error("registry unavailable");
    return catalog;
  });
  view();
  fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
  expect(
    await screen.findByText("Could not check for updates"),
  ).toBeInTheDocument();
  expect(screen.queryByText("You’re all up to date")).not.toBeInTheDocument();
});

it("does not let a failed update check block other package actions", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "check_package_updates")
      throw new Error("registry unavailable");
    if (command === "search_package_catalog") return catalog;
    return { progress: [] };
  });
  view();
  fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
  await screen.findByText("Could not check for updates");
  fireEvent.click(screen.getByRole("button", { name: /Installed · 1/ }));
  fireEvent.click(screen.getByRole("button", { name: "View Review" }));
  const dialog = screen.getByRole("dialog", { name: "Review package details" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Update Review" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("update_package", {
      source: resource.packageSource,
    }),
  );
});

it("appends catalogue pages and applies resource filters to the loaded results", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command !== "search_package_catalog"
      ? { updates: [] }
      : args?.offset === 1
        ? {
            total: 2,
            nextOffset: null,
            packages: [
              {
                ...catalog.packages[0],
                source: "npm:pi-theme",
                name: "pi-theme",
                kinds: ["theme"],
              },
            ],
          }
        : { ...catalog, total: 2, nextOffset: 1 },
  );
  view();
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more packages" }),
  );
  expect(
    await screen.findByRole("button", { name: "View Theme" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Themes" }));
  expect(
    screen.queryByRole("button", { name: "View Review" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "View Theme" }),
  ).toBeInTheDocument();
});

it("filters unrelated results because npm keyword searches rank text without excluding other Pi packages", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command !== "search_package_catalog"
      ? { updates: [] }
      : {
          ...catalog,
          packages: [
            ...catalog.packages,
            {
              ...catalog.packages[0],
              source: "npm:pi-theme",
              name: "pi-theme",
              description: "Terminal colours",
              kinds: ["theme"],
            },
          ],
        },
  );
  view();
  expect(
    await screen.findByRole("button", { name: "View Theme" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Search packages" }), {
    target: { value: "review changes" },
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("search_package_catalog", {
      query: "review changes",
      offset: 0,
    }),
  );
  expect(
    await screen.findByRole("button", { name: "View Review" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "View Theme" }),
  ).not.toBeInTheDocument();
});

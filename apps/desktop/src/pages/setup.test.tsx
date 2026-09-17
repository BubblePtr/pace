import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@/shared/runtime";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PackageManagement,
  PackageActionFeedback,
  InstallPackageButton,
  usePackageActions,
  ConfigInventoryView,
  SetupInventoryControls,
  type ConfigInventory,
  type SetupCategory,
} from "@/pages/packages/resources";

function ResourceManagement({ inventory, selected }: { inventory: ConfigInventory; selected: SetupCategory }) {
  return <PackageManagement inventory={inventory}><InstallPackageButton /><LocalButton /><PackageActionFeedback /><ConfigInventoryView inventory={inventory} selected={selected} /></PackageManagement>;
}
function LocalButton() {
  const actions = usePackageActions();
  return <button onClick={() => void actions.run("select_local_resource", {})}>Add local resource</button>;
}

const resources: ConfigInventory["extensions"] = [
  { kind: "extension", name: "terminal-tools", path: "/kit/tool.ts", enabled: true, origin: "package", scope: "user", packageSource: "@pi/code" },
  { kind: "skill", name: "review", path: "/kit/SKILL.md", enabled: false, origin: "package", scope: "user", packageSource: "@pi/code" },
  { kind: "prompt", name: "plan", path: "/kit/plan.md", enabled: true, origin: "package", scope: "user", packageSource: "@pi/code" },
  { kind: "theme", name: "night", path: "/kit/night.json", enabled: true, origin: "package", scope: "user", packageSource: "@pi/code" },
];
const inventory: ConfigInventory = {
  defaultModel: "gpt-5-codex",
  defaultProvider: "openai",
  defaultThinkingLevel: "high",
  theme: "system",
  packages: [{ source: "@pi/code", scope: "user", filtered: true, installedPath: "/kit", resources }],
  extensions: [resources[0], { kind: "extension", name: "drop", path: "/extensions/drop.ts", origin: "drop-in", scope: "user", enabled: true }, { kind: "extension", name: "explicit", path: "/custom/tool.ts", origin: "top-level", scope: "user", enabled: false }],
  skills: [resources[1]],
  promptTemplates: [resources[2]],
  themes: [resources[3]],
};

const incompleteInventory: ConfigInventory = {
  defaultModel: "",
  defaultProvider: undefined,
  defaultThinkingLevel: "",
  theme: undefined,
  packages: [],
  extensions: [],
  skills: [],
  promptTemplates: [],
  themes: [],
};

describe("ConfigInventoryView", () => {
  it("renders model defaults", () => {
    const { container } = render(<ConfigInventoryView inventory={inventory} selected="models" />);

    expect(screen.getByText("gpt-5-codex")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("system")).toBeInTheDocument();
    expect(container.querySelector(".astryx-card")).toBeInTheDocument();
  });

  it("shows no loaded resources for empty prompt templates", () => {
    render(<ConfigInventoryView inventory={incompleteInventory} selected="templates" />);

    expect(screen.getByText("Prompt Templates")).toBeInTheDocument();
    expect(screen.getByText("No resources loaded yet")).toBeInTheDocument();
  });

  it("uses English labels for missing model defaults", () => {
    render(<ConfigInventoryView inventory={incompleteInventory} selected="models" />);

    expect(screen.getAllByText("Not set")).toHaveLength(4);
  });

  it("groups every package resource by kind and exposes disabled resources without controls", () => {
    render(<ConfigInventoryView inventory={inventory} selected="packages" />);
    expect(screen.getByText("@pi/code")).toBeInTheDocument();
    for (const label of ["Extensions", "Skills", "Prompt Templates", "Themes", "terminal-tools", "review", "plan", "night"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText(/disabled/)).toBeInTheDocument();
    expect(screen.getByText(/Only affects the Pi terminal/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows origin and package ownership in resource views", () => {
    render(<ConfigInventoryView inventory={inventory} selected="extensions" />);
    expect(screen.getByText(/package · @pi\/code/)).toBeInTheDocument();
    expect(screen.getByText(/drop-in · Auto-loaded from a convention directory/)).toBeInTheDocument();
    expect(screen.getByText(/disabled · user · top-level/)).toBeInTheDocument();
  });

  it("explains the terminal-only scope in the themes view", () => {
    render(<ConfigInventoryView inventory={inventory} selected="themes" />);
    expect(screen.getByText("night")).toBeInTheDocument();
    expect(screen.getByText(/Only affects the Pi terminal/)).toBeInTheDocument();
  });
});

describe("SetupInventoryControls", () => {
  it("renders setup categories with Astryx SegmentedControl", () => {
    const { container } = render(
      <SetupInventoryControls
        selected="models"
        onSelect={() => {}}
        inventory={inventory}
        isFetching={false}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Configuration sections" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Models/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Packages/ })).toBeInTheDocument();
    expect(container.querySelector(".astryx-segmented-control")).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(6);
  });
});


vi.mock("@/shared/runtime", () => ({ invoke: vi.fn() }));

describe("resource actions", () => {
  it("toggles package resources, invalidates inventory and reports failures", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.mocked(invoke).mockResolvedValue({ progress: [] });
    render(<QueryClientProvider client={client}><ResourceManagement inventory={inventory} selected="extensions" /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("switch", { name: "Enable terminal-tools" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_resource_enabled", { path: "/kit/tool.ts", kind: "extension", packageSource: "@pi/code", enabled: false }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["config-inventory"] }));
    expect(await screen.findByText(/Takes effect in the next new Session/)).toBeInTheDocument();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("settings locked"));
    fireEvent.click(screen.getByRole("switch", { name: "Enable terminal-tools" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("settings locked");
    expect(screen.getByRole("switch", { name: "Enable explicit" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("switch", { name: "Enable drop" })).not.toBeInTheDocument();
  });
});


it("validates install sources, prevents duplicate installs and shows returned progress", async () => {
  let complete!: (value: unknown) => void;
  vi.mocked(invoke).mockReset().mockImplementation(command => command === "check_package_updates" ? Promise.resolve({ updates: [] }) : new Promise(resolve => { complete = resolve; }));
  render(<QueryClientProvider client={new QueryClient()}><ResourceManagement inventory={inventory} selected="packages" /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Install package" }));
  const input = screen.getByRole("textbox", { name: "npm package or git URL" });
  fireEvent.change(input, { target: { value: "./local" } });
  expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "git:example.org/kit" } });
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
  complete({ progress: [{ type: "complete", action: "clone", source: "git:example.org/kit", message: "Cloned" }] });
  expect(await screen.findByText(/Cloned/)).toBeInTheDocument();
});


it("confirms local replacement and package removal before writing", async () => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "select_local_resource") return "/tmp/foo.ts";
    if (command === "add_local_resource" && !args?.overwrite) return { conflict: true, path: "/agent/extensions/foo.ts" };
    return { progress: [], updates: [] };
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<QueryClientProvider client={new QueryClient()}><ResourceManagement inventory={inventory} selected="packages" /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Add local resource" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("add_local_resource", { path: "/tmp/foo.ts", overwrite: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Remove @pi/code" })).not.toBeDisabled());
  confirm.mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Remove @pi/code" }));
  expect(invoke).not.toHaveBeenCalledWith("remove_package", expect.anything());
  confirm.mockReturnValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove @pi/code" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove_package", { source: "@pi/code" }));
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("source files are kept"));
  confirm.mockRestore();
});


it("disables terminal themes and CLI bare packages, and confirms drop-in deletion", async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ progress: [] });
  const bare = { ...resources[0], path: "/single.ts", packageSource: "./single.ts" };
  const data = { ...inventory, extensions: [bare, ...inventory.extensions], packages: [...inventory.packages, { source: "./single.ts", scope: "user" as const, installedPath: "/single.ts", filtered: false, resources: [bare] }] };
  const client = new QueryClient();
  const { rerender } = render(<QueryClientProvider client={client}><ResourceManagement inventory={data} selected="themes" /></QueryClientProvider>);
  expect(screen.getByRole("switch", { name: "Enable night" })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("Only affects the Pi terminal");
  fireEvent.click(screen.getByRole("switch", { name: "Enable night" }));
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command !== "check_package_updates")).toHaveLength(0);
  rerender(<QueryClientProvider client={client}><ResourceManagement inventory={data} selected="extensions" /></QueryClientProvider>);
  const switches = screen.getAllByRole("switch", { name: "Enable terminal-tools" });
  expect(switches[0]).toHaveAttribute("aria-disabled", "true");
  expect(switches[1]).not.toHaveAttribute("aria-disabled", "true");
  expect(screen.getAllByRole("tooltip", { hidden: true }).map(tooltip => tooltip.textContent)).toContain(
    "Pi ignores Resource Filter toggles for local file or bare-directory packages. Remove the registration or move the resource into a convention directory.",
  );
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete drop" }));
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command !== "check_package_updates")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Delete drop" }));
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Removing the file disables it"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove_local_resource", { path: "/extensions/drop.ts" }));
  confirm.mockRestore();
});

it("checks updates once on entry, keeps the badge across sections, and rechecks after Update", async () => {
  vi.mocked(invoke).mockReset().mockImplementation(async command => command === "check_package_updates" ? { updates: [{ source: "@pi/code", scope: "user", type: "npm", displayName: "kit" }] } : { progress: [] });
  const client = new QueryClient();
  const view = (selected: "packages" | "extensions") => <QueryClientProvider client={client}><ResourceManagement inventory={inventory} selected={selected} /></QueryClientProvider>;
  const { rerender } = render(view("packages"));
  expect(await screen.findByText("Update available")).toBeInTheDocument();
  rerender(view("extensions"));
  rerender(view("packages"));
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_package_updates")).toHaveLength(1);
  vi.mocked(invoke).mockImplementation(async command => command === "check_package_updates" ? { updates: [] } : { progress: [] });
  fireEvent.click(screen.getByRole("button", { name: "Update @pi/code" }));
  await waitFor(() => expect(screen.queryByText("Update available")).not.toBeInTheDocument());
  expect(invoke).toHaveBeenCalledWith("update_package", { source: "@pi/code" });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_package_updates")).toHaveLength(2);
});

it("shows the journal error and timestamp in package details and drop-in resources without empty placeholders", () => {
  const lastError = { sessionId: "session", timestamp: "2026-09-09T12:00:00Z", message: "/kit/tool.ts: failed to load" };
  const data = { ...inventory, packages: [{ ...inventory.packages[0], resources: [{ ...resources[0], lastError }, resources[1]] }], extensions: [{ ...inventory.extensions[1], lastError: { ...lastError, message: "drop failed" } }] };
  const { rerender } = render(<ConfigInventoryView inventory={data} selected="packages" />);
  expect(screen.getByText(lastError.message)).toBeInTheDocument();
  expect(screen.getByText(/Latest extension error/).querySelector("time")).toHaveAttribute("datetime", lastError.timestamp);
  expect(screen.getAllByText(/Latest extension error/)).toHaveLength(1);
  rerender(<ConfigInventoryView inventory={data} selected="extensions" />);
  expect(screen.getByText("drop failed")).toBeInTheDocument();
});

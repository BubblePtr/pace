import { Token } from "@astryxdesign/core/Token";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Switch } from "@astryxdesign/core/Switch";
import { HStack } from "@astryxdesign/core/HStack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState as AstryxEmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Box, Cancel, Palette, Puzzle, RefreshCw, Settings2, Sparkles, Wrench } from "@/shared/ui/icons";
import { invoke } from "@/shared/runtime";

import type { ConfigInventory, ResourceInfo, PackageInfo, PackageProgressEvent, PackageActionResult, AddLocalResourceResult, CheckPackageUpdatesResult } from "@pace/core";

export type { ConfigInventory, ResourceInfo, PackageInfo } from "@pace/core";

export type SetupCategory = "models" | "packages" | "extensions" | "skills" | "templates" | "themes";

const categoryMeta = {
  models: { label: "Models", icon: Settings2 },
  packages: { label: "Packages", icon: Box },
  extensions: { label: "Extensions", icon: Wrench },
  skills: { label: "Skills", icon: Puzzle },
  templates: { label: "Prompt Templates", icon: Sparkles },
  themes: { label: "Themes", icon: Palette },
} as const;

function valueOrMissing(value?: string) {
  return value && value.trim().length > 0 ? value : "Not set";
}

function categoryCount(category: SetupCategory, inventory?: ConfigInventory) {
  if (!inventory) {
    return "";
  }

  switch (category) {
    case "models":
      return "4";
    case "packages":
      return String(inventory.packages.length);
    case "extensions":
      return String(inventory.extensions.length);
    case "skills":
      return String(inventory.skills.length);
    case "themes":
      return String(inventory.themes.length);
    case "templates":
      return String(inventory.promptTemplates.length);
  }
}

export function SetupInventoryControls({
  selected,
  onSelect,
  inventory,
  isFetching,
  onRefresh,
}: {
  selected: SetupCategory;
  onSelect: (category: SetupCategory) => void;
  inventory?: ConfigInventory;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const categories = Object.keys(categoryMeta) as SetupCategory[];

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Inventory sections</h2>
          <p className="mt-1 text-xs text-muted">Manage Pi packages and resources</p>
        </div>
        <IconButton
          className="pigui-pressable"
          label="Refresh setup"
          icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />}
          isDisabled={isFetching}
          size="sm"
          variant="secondary"
          onClick={onRefresh}
        />
      </div>

      <div className="w-full max-w-full overflow-x-auto">
        <SegmentedControl
          label="Configuration sections"
          size="sm"
          value={selected}
          onChange={(value) => onSelect(value as SetupCategory)}
        >
          {categories.map((category) => {
            const meta = categoryMeta[category];
            const Icon = meta.icon;
            const count = categoryCount(category, inventory);

            return (
              <SegmentedControlItem
                key={category}
                value={category}
                label={count ? `${meta.label} · ${count}` : meta.label}
                icon={<Icon className="size-4 shrink-0" />}
              />
            );
          })}
        </SegmentedControl>
      </div>
    </Card>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted p-4">
      <div className="text-xs font-medium uppercase text-muted">{label}</div>
      <div className="mt-2 break-words text-base font-semibold text-foreground">{value}</div>
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return <AstryxEmptyState isCompact title={children} />;
}

const resourceGroups = [
  { kind: "extension", label: "Extensions" },
  { kind: "skill", label: "Skills" },
  { kind: "prompt", label: "Prompt Templates" },
  { kind: "theme", label: "Themes" },
] as const;

const ActionsContext = createContext<{
  pending: boolean;
  updates: CheckPackageUpdatesResult["updates"];
  updatesLoading: boolean;
  updatesError: string | null;
  refreshUpdates: () => void;
  packages: PackageInfo[];
  openInstall: () => void;
  error: string;
  message: string;
  progress: PackageProgressEvent[];
  dismissFeedback: () => void;
  run: (command: string, args: Record<string, unknown>) => Promise<boolean>;
} | null>(null);

export function usePackageActions() {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("Package actions require PackageManagement");
  return actions;
}

export function InstallPackageButton() {
  const actions = usePackageActions();
  return <Button label="Install package" isDisabled={actions.pending} onClick={actions.openInstall} />;
}

export function PackageActionFeedback() {
  const actions = usePackageActions();
  if (!actions.pending && !actions.error && !actions.message && !actions.progress.length) return null;
  return <VStack gap={2}>
    <HStack gap={2} hAlign="between" vAlign="center">{actions.pending ? <Text role="status">Working…</Text> : <Text type="supporting">Package activity</Text>}{!actions.pending && <IconButton label="Dismiss package activity" icon={<Cancel />} variant="ghost" size="sm" onClick={actions.dismissFeedback} />}</HStack>
    {actions.error && <Text role="alert" style={{ color: "var(--danger)" }}>{actions.error}</Text>}
    {actions.message && <Text role="status">{actions.message}</Text>}
    {actions.progress.length > 0 && <List hasDividers>{actions.progress.map((event, index) => <ListItem key={index} label={`${event.action}: ${event.type}`} description={`${event.source} ${event.message ?? ""}`} />)}</List>}
  </VStack>;
}
const nextSessionCopy = "Takes effect in the next new Session. Running Sessions are not affected.";

function ResourceControls({ resource }: { resource: ResourceInfo }) {
  const actions = useContext(ActionsContext);
  if (!actions) return null;
  if (resource.origin === "drop-in") return <HStack gap={2}>
    <Button label="Reveal in Finder" size="sm" variant="ghost" onClick={() => void actions.run("reveal_project_in_finder", { path: resource.path })} />
    <Button label={`Delete ${resource.name}`} size="sm" variant="destructive" isDisabled={actions.pending} onClick={() => {
      if (window.confirm(`Delete ${resource.path}? Removing the file disables it. A Skill deletes its whole directory.`)) void actions.run("remove_local_resource", { path: resource.path });
    }} />
  </HStack>;
  const pkg = actions.packages.find(pkg => pkg.source === resource.packageSource);
  const reason = resource.kind === "theme" ? "Only affects the Pi terminal" : !resource.packageSource || resource.packageSource === "auto" || resource.origin === "top-level"
    ? "Drop-in and top-level resources have no package filter; remove the resource file instead"
    : pkg?.installedPath === resource.path ? "Pi ignores Resource Filter toggles for local file or bare-directory packages. Remove the registration or move the resource into a convention directory." : undefined;
  return <Switch label={`Enable ${resource.name}`} isLabelHidden value={resource.enabled} isDisabled={actions.pending || !!reason} disabledMessage={reason} onChange={enabled => void actions.run("set_resource_enabled", { path: resource.path, kind: resource.kind, packageSource: resource.packageSource, enabled })} />;
}

export function PackageManagement({ inventory, children }: { inventory: ConfigInventory; children: ReactNode }) {
  const client = useQueryClient();
  const updates = useQuery({
    queryKey: ["package-updates"],
    queryFn: () => invoke<CheckPackageUpdatesResult>("check_package_updates"),
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [source, setSource] = useState("");
  const [progress, setProgress] = useState<PackageProgressEvent[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const run = async (command: string, args: Record<string, unknown>) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true); setError(""); setMessage(""); setProgress([]);
    try {
      if (command === "select_local_resource") {
        const path = await invoke<string | null>(command);
        if (!path) return false;
        const imported = await invoke<AddLocalResourceResult>("add_local_resource", { path });
        if (imported.conflict) {
          if (!window.confirm(`Overwrite ${imported.path}? The resource with the same name will be replaced.`)) return false;
          await invoke("add_local_resource", { path, overwrite: true });
        }
      }
      const result = command === "select_local_resource" ? undefined : await invoke<PackageActionResult>(command, args);
      setProgress(result?.progress ?? []);
      await client.invalidateQueries({ queryKey: ["config-inventory"] });
      if (["update_package", "install_package", "remove_package"].includes(command)) {
        await client.invalidateQueries({ queryKey: ["package-updates"] });
      }
      setMessage(command === "reveal_project_in_finder" ? "Revealed in Finder" : nextSessionCopy);
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { busy.current = false; setPending(false); }
  };
  return <ActionsContext.Provider value={{ pending, updates: updates.data?.updates ?? [], updatesLoading: updates.isPending, updatesError: updates.isError ? updates.error.message : null, refreshUpdates: () => void updates.refetch(), packages: inventory.packages, openInstall: () => { setError(""); setInstallOpen(true); }, error, message, progress, dismissFeedback: () => { setError(""); setMessage(""); setProgress([]); }, run }}><VStack gap={3}>
    {children}
    {installOpen && <Dialog isOpen={installOpen} onOpenChange={open => { if (!pending) setInstallOpen(open); }} purpose="form">
      <Layout header={<DialogHeader title="Install package" onOpenChange={open => { if (!pending) setInstallOpen(open); }} />} content={<LayoutContent><form onSubmit={event => { event.preventDefault(); if (!busy.current && /^(npm:|git:|https:\/\/)\S+$/.test(source.trim())) void run("install_package", { source: source.trim() }).then(ok => { if (ok) { setInstallOpen(false); setSource(""); } }); }}><VStack gap={3}>
        <TextInput label="npm package or git URL" description="npm:, git:, or https://. Use Add local resource for local files." value={source} onChange={setSource} isDisabled={pending} />
        <Text type="supporting">Git installs can take a minute or two; progress is not streamed while it runs.</Text>
        <Text type="supporting">{nextSessionCopy}</Text>
        {error && <Text role="alert" style={{ color: "var(--danger)" }}>{error}</Text>}
        <Button type="submit" label={pending ? "Installing…" : "Install"} variant="primary" isDisabled={pending || !/^(npm:|git:|https:\/\/)\S+$/.test(source.trim())} />
      </VStack></form></LayoutContent>} />
    </Dialog>}
  </VStack></ActionsContext.Provider>;
}

export function ResourceList({ resources }: { resources: ResourceInfo[] }) {
  if (resources.length === 0) return <EmptyState>No resources loaded yet</EmptyState>;
  return (
    <List hasDividers>
      {resources.map(resource => (
        <ListItem
          key={`${resource.kind}:${resource.path}`}
          endContent={<ResourceControls resource={resource} />}
          label={resource.name}
          description={<VStack gap={1}><Text type="supporting">{[
            resource.enabled ? "enabled" : "disabled",
            resource.scope,
            resource.origin,
            resource.packageSource,
            resource.origin === "drop-in" ? "Auto-loaded from a convention directory" : undefined,
            resource.kind === "theme" ? "Only affects the Pi terminal" : undefined,
            resource.path,
          ].filter(Boolean).join(" · ")}</Text>
            {resource.lastError && <>
              <Text type="supporting">Latest extension error · <time dateTime={resource.lastError.timestamp}>{new Date(resource.lastError.timestamp).toLocaleString()}</time></Text>
              <Text style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>{resource.lastError.message}</Text>
            </>}
          </VStack>}
        />
      ))}
    </List>
  );
}

export function PackageList({ packages }: { packages: PackageInfo[] }) {
  const actions = useContext(ActionsContext);
  if (packages.length === 0) return <EmptyState>No packages installed yet</EmptyState>;
  return (
    <VStack gap={6}>
      {packages.map(pkg => (
        <VStack key={`${pkg.scope}:${pkg.source}`} gap={3}>
          <HStack gap={3} vAlign="center">
            <Heading level={3}>{pkg.source}</Heading>
            {actions?.updates.some(update => update.source === pkg.source && update.scope === pkg.scope) && <Token size="sm" label="Update available" />}
            {actions && <>
              <Button label={`Update ${pkg.source}`} variant="ghost" size="sm" isDisabled={actions.pending} onClick={() => void actions.run("update_package", { source: pkg.source })} />
              <Button label={`Remove ${pkg.source}`} variant="destructive" size="sm" isDisabled={actions.pending} onClick={() => {
                if (window.confirm(`Remove ${pkg.source}? Pi cleans up npm / git install directories. A local Package registered from the CLI is only unregistered; its source files are kept.`)) void actions.run("remove_package", { source: pkg.source });
              }} />
            </>}
          </HStack>
          <Text type="supporting">{pkg.scope} · {pkg.filtered ? "Filtered" : "Unfiltered"} · {pkg.installedPath ?? "Not installed"}</Text>
          {resourceGroups.map(group => (
            <VStack key={group.kind} gap={1}>
              <Heading level={4}>{group.label}</Heading>
              <ResourceList resources={pkg.resources.filter(resource => resource.kind === group.kind)} />
            </VStack>
          ))}
        </VStack>
      ))}
    </VStack>
  );
}

export function ConfigInventoryView({
  inventory,
  selected,
}: {
  inventory: ConfigInventory;
  selected: SetupCategory;
}) {
  const title = categoryMeta[selected].label;

  return (
    <Card>
      <div className="border-b border-border pb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted">Resources from PI_CODING_AGENT_DIR.</p>
      </div>

      <div className="mt-4">
        {selected === "models" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <KeyValue label="Default model" value={valueOrMissing(inventory.defaultModel)} />
            <KeyValue label="Default provider" value={valueOrMissing(inventory.defaultProvider)} />
            <KeyValue
              label="Thinking level"
              value={valueOrMissing(inventory.defaultThinkingLevel)}
            />
            <KeyValue label="Theme" value={valueOrMissing(inventory.theme)} />
          </div>
        ) : selected === "packages" ? (
          <PackageList packages={inventory.packages} />
        ) : selected === "extensions" ? (
          <ResourceList resources={inventory.extensions} />
        ) : selected === "skills" ? (
          <ResourceList resources={inventory.skills} />
        ) : selected === "themes" ? (
          <ResourceList resources={inventory.themes} />
        ) : (
          <ResourceList resources={inventory.promptTemplates} />
        )}
      </div>
    </Card>
  );
}

import { useEffect, useState, type CSSProperties } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Button,
  Card,
  Dialog,
  DialogHeader,
  EmptyState,
  Grid,
  Heading,
  HStack,
  IconButton,
  Layout,
  LayoutContent,
  Selector,
  Tab,
  TabList,
  Text,
  TextInput,
  Token,
  VStack,
} from "@astryxdesign/core";
import type {
  CatalogPackage,
  ConfigInventory,
  PackageCatalogPage,
  PackageInfo,
  ResourceInfo,
} from "@pace/core";
import { invoke } from "@/shared/runtime";
import {
  ArrowRight,
  Bot,
  Box,
  Cancel,
  Check,
  Globe,
  LinkExternal,
  Palette,
  Puzzle,
  Search,
  Wrench,
} from "@/shared/ui/icons";
import {
  ConfigInventoryView,
  InstallPackageButton,
  PackageActionFeedback,
  ResourceList,
  SetupInventoryControls,
  usePackageActions,
  type SetupCategory,
} from "./resources";
import "./marketplace.css";

type BrowseTab = "discover" | "installed" | "updates";
type Kind = ResourceInfo["kind"];
const kindLabels = {
  extension: "Extensions",
  skill: "Skills",
  prompt: "Prompts",
  theme: "Themes",
} as const;
const kinds = Object.keys(kindLabels) as Kind[];
type Entry = {
  key: string;
  title: string;
  name: string;
  description: string;
  author?: string;
  kinds: Kind[];
  installed?: PackageInfo;
  catalog?: CatalogPackage;
};

function npmName(source: string) {
  return /^npm:((?:@[^/]+\/)?[^@]+)(?:@.*)?$/.exec(source)?.[1];
}

function entry(catalog?: CatalogPackage, installed?: PackageInfo): Entry {
  const name =
    installed?.name ??
    catalog?.name ??
    npmName(installed!.source) ??
    installed!.source;
  const shortName =
    name
      .split("/")
      .filter(Boolean)
      .slice(-1)[0]
      ?.replace(/^pi-/, "")
      .replace(/-/g, " ") ?? name;
  return {
    key: installed ? `${installed.scope}:${installed.source}` : catalog!.source,
    name,
    title: (shortName.charAt(0).toUpperCase() + shortName.slice(1)).replace(
      /\bmcp\b/gi,
      "MCP",
    ),
    description:
      installed?.description ??
      catalog?.description ??
      (installed?.resources.length
        ? installed.resources.map((resource) => resource.name).join(" · ")
        : "No package description available."),
    author: installed?.author ?? catalog?.author,
    kinds: installed
      ? [...new Set(installed.resources.map((resource) => resource.kind))]
      : catalog!.kinds,
    installed,
    catalog,
  };
}

function Glyph({ pkg, large = false }: { pkg: Entry; large?: boolean }) {
  const Icon = pkg.name.includes("subagent")
    ? Bot
    : pkg.name.includes("web")
      ? Globe
      : pkg.kinds.includes("skill")
        ? Puzzle
        : pkg.kinds.includes("theme")
          ? Palette
          : Wrench;
  const color =
    Icon === Bot
      ? "blue"
      : Icon === Globe
        ? "green"
        : Icon === Puzzle
          ? "orange"
          : Icon === Palette
            ? "amber"
            : "slate";
  return (
    <HStack
      className={`package-glyph${large ? " package-glyph-large" : ""}`}
      vAlign="center"
      hAlign="center"
      style={
        { "--package-color": `var(--pigui-data-${color})` } as CSSProperties
      }
      aria-hidden="true"
    >
      <Icon />
    </HStack>
  );
}

function PackageAction({
  pkg,
  onManage,
}: {
  pkg: Entry;
  onManage: () => void;
}) {
  const actions = usePackageActions();
  const hasUpdate =
    pkg.installed &&
    actions.updates.some(
      (update) =>
        update.source === pkg.installed!.source &&
        update.scope === pkg.installed!.scope,
    );
  const label = hasUpdate ? "Update" : pkg.installed ? "Manage" : "Install";
  return (
    <Button
      label={`${label} ${pkg.title}`}
      size="sm"
      variant={pkg.installed && !hasUpdate ? "ghost" : "secondary"}
      isDisabled={actions.pending}
      icon={pkg.installed && !hasUpdate ? <Check /> : undefined}
      onClick={() => {
        if (hasUpdate)
          void actions.run("update_package", { source: pkg.installed!.source });
        else if (pkg.installed) onManage();
        else
          void actions.run("install_package", { source: pkg.catalog!.source });
      }}
    >
      {label}
    </Button>
  );
}

function PackageDetail({ pkg, onClose }: { pkg: Entry; onClose: () => void }) {
  const [tab, setTab] = useState("overview");
  const actions = usePackageActions();
  return (
    <Dialog
      isOpen
      aria-label={`${pkg.title} package details`}
      width="min(94vw, calc(var(--spacing-10) * 14))"
      maxHeight="85dvh"
      onOpenChange={(open) => !open && onClose()}
      purpose="form"
    >
      <Layout
        content={
          <LayoutContent>
            <VStack gap={6} className="package-detail">
              <HStack hAlign="between" vAlign="center">
                <Text type="supporting">Package details</Text>
                <IconButton
                  label="Close package details"
                  icon={<Cancel />}
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                />
              </HStack>
              <VStack gap={3}>
                <Glyph pkg={pkg} large />
                <VStack gap={1}>
                  <Heading level={2}>{pkg.title}</Heading>
                  <Text type="supporting" className="package-source">
                    {pkg.name}
                  </Text>
                  {pkg.author && <Text type="supporting">by {pkg.author}</Text>}
                </VStack>
                <Text>{pkg.description}</Text>
                <HStack gap={2} wrap="wrap">
                  {pkg.kinds.map((kind) => (
                    <Token key={kind} label={kindLabels[kind]} size="sm" />
                  ))}
                  {pkg.installed && (
                    <Token
                      label={
                        pkg.installed.installedPath
                          ? "Installed"
                          : "Not installed"
                      }
                      size="sm"
                    />
                  )}
                </HStack>
                <HStack gap={3} vAlign="center" wrap="wrap">
                  {pkg.installed ? (
                    <Button
                      label="Manage resources"
                      variant="ghost"
                      size="sm"
                      onClick={() => setTab("resources")}
                    />
                  ) : (
                    <PackageAction
                      pkg={pkg}
                      onManage={() => setTab("resources")}
                    />
                  )}
                  {pkg.installed && (
                    <Text type="supporting">
                      Installed version · {pkg.installed.version ?? "Unknown"}
                    </Text>
                  )}
                  {pkg.catalog && (
                    <Text type="supporting">
                      Latest on npm · {pkg.catalog.version}
                    </Text>
                  )}
                </HStack>
              </VStack>
              <PackageActionFeedback />
              <TabList value={tab} onChange={setTab} hasDivider>
                <Tab value="overview" label="Overview" />
                <Tab value="resources" label="Resources" />
              </TabList>
              {tab === "overview" ? (
                <VStack gap={3}>
                  <Text className="package-source" type="supporting">
                    Source: {pkg.installed?.source ?? pkg.catalog?.source}
                  </Text>
                  <Text type="supporting">
                    Scope: {pkg.installed?.scope ?? "user"}
                  </Text>
                  {pkg.installed && (
                    <Text type="supporting" className="package-source">
                      {pkg.installed.installedPath ??
                        "Package is registered but not installed. Use Update package to restore it."}
                    </Text>
                  )}
                  <Text type="supporting">
                    Takes effect in the next new Session. Running Sessions are
                    not affected.
                  </Text>
                  {pkg.catalog && (
                    <a
                      className="package-external"
                      href={`https://www.npmjs.com/package/${encodeURIComponent(pkg.catalog.name)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on npm <LinkExternal />
                    </a>
                  )}
                </VStack>
              ) : pkg.installed ? (
                <VStack gap={3}>
                  <Text type="supporting">
                    Choose what Pi loads in your next new Session.
                  </Text>
                  <ResourceList resources={pkg.installed.resources} />
                </VStack>
              ) : (
                <VStack gap={3}>
                  <Text type="supporting">
                    Install this package to see and manage its resolved
                    resources.
                  </Text>
                  <Text type="supporting">
                    {pkg.catalog?.typesKnown
                      ? `Declared resource types: ${pkg.kinds.map((kind) => kindLabels[kind]).join(", ") || "None"}`
                      : "Resource types are unavailable. This package may use convention directories."}
                  </Text>
                </VStack>
              )}
              {pkg.installed && (
                <HStack gap={2} wrap="wrap">
                  <Button
                    label={`Update ${pkg.title}`}
                    variant="secondary"
                    isDisabled={actions.pending}
                    onClick={() =>
                      void actions.run("update_package", {
                        source: pkg.installed!.source,
                      })
                    }
                  >
                    Update package
                  </Button>
                  <Button
                    label={`Remove ${pkg.title}`}
                    variant="ghost"
                    isDisabled={actions.pending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${pkg.installed!.source}? Pi cleans up npm / git install directories. A local Package registered from the CLI is only unregistered; its source files are kept.`,
                        )
                      )
                        void actions
                          .run("remove_package", {
                            source: pkg.installed!.source,
                          })
                          .then((ok) => {
                            if (ok) onClose();
                          });
                    }}
                  >
                    Remove package
                  </Button>
                </HStack>
              )}
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function Spotlight({ onSearch }: { onSearch: (query: string) => void }) {
  return (
    <Grid columns={2} gap={4} className="package-features">
      <Card padding={0} className="package-feature feature-agents">
        <VStack padding={6} gap={5}>
          <HStack hAlign="between" vAlign="center">
            <Text type="supporting" className="package-eyebrow">
              Spotlight · Subagents
            </Text>
            <Bot />
          </HStack>
          <VStack gap={2}>
            <Heading level={2} className="package-feature-title">
              Good work takes
              <br />a great team.
            </Heading>
            <Text className="package-feature-copy">
              Give research, reviews and implementation
              <br />
              their own focused agent.
            </Text>
          </VStack>
          <HStack
            gap={2}
            vAlign="center"
            className="agent-workflow"
            aria-label="Scout then Build then Review"
          >
            <Text>Scout</Text>
            <ArrowRight />
            <Text>Build</Text>
            <ArrowRight />
            <Text>Review</Text>
          </HStack>
          <Button
            label="Explore Subagents"
            variant="primary"
            endContent={<ArrowRight />}
            style={{ alignSelf: "flex-start" }}
            onClick={() => onSearch("subagent")}
          />
        </VStack>
      </Card>
      <Card padding={0} className="package-feature feature-web">
        <VStack padding={6} gap={5}>
          <HStack hAlign="between" vAlign="center">
            <Text type="supporting" className="package-eyebrow">
              Expand your reach
            </Text>
            <Globe />
          </HStack>
          <VStack gap={2}>
            <Heading level={2} className="package-feature-title">
              A world beyond
              <br />
              your workspace.
            </Heading>
            <Text className="package-feature-copy">
              Search the web. Read the source.
              <br />
              Bring fresh context to every task.
            </Text>
          </VStack>
          <HStack gap={2} vAlign="center" className="web-workflow">
            <Globe />
            <Text>Search → Read → Understand</Text>
          </HStack>
          <Button
            label="Explore Web access"
            endContent={<ArrowRight />}
            style={{ alignSelf: "flex-start" }}
            onClick={() => onSearch("web")}
          />
        </VStack>
      </Card>
    </Grid>
  );
}

export function Marketplace({
  inventory,
  refreshing,
  onRefresh,
  onEnvironmentCheck,
}: {
  inventory: ConfigInventory;
  refreshing: boolean;
  onRefresh: () => void;
  onEnvironmentCheck: () => void;
}) {
  const actions = usePackageActions();
  const [tab, setTab] = useState<BrowseTab>("discover");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Kind | "all">("all");
  const [sort, setSort] = useState("relevance");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [inspector, setInspector] = useState(false);
  const [section, setSection] = useState<SetupCategory>("extensions");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  const catalog = useInfiniteQuery({
    queryKey: ["package-catalog", search],
    queryFn: ({ pageParam }) =>
      invoke<PackageCatalogPage>("search_package_catalog", {
        query: search,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: tab === "discover",
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const catalogPackages = [
    ...new Map(
      catalog.data?.pages
        .flatMap((page) => page.packages)
        .map((pkg) => [pkg.name, pkg]),
    ).values(),
  ];
  const installedFor = (pkg: CatalogPackage) =>
    inventory.packages.find(
      (installed) =>
        installed.scope === "user" && npmName(installed.source) === pkg.name,
    );
  const localEntries = inventory.packages.map((pkg) =>
    entry(
      catalogPackages.find(
        (candidate) => candidate.name === npmName(pkg.source),
      ),
      pkg,
    ),
  );
  const entries =
    tab === "discover"
      ? catalogPackages.map((pkg) => entry(pkg, installedFor(pkg)))
      : localEntries.filter(
          (pkg) =>
            tab === "installed" ||
            actions.updates.some(
              (update) =>
                update.source === pkg.installed!.source &&
                update.scope === pkg.installed!.scope,
            ),
        );
  const items = entries
    .filter(
      (pkg) =>
        (category === "all" || pkg.kinds.includes(category)) &&
        query
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .every((term) =>
            `${pkg.name} ${pkg.description} ${pkg.author ?? ""}`
              .toLowerCase()
              .includes(term),
          ),
    )
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : 0));
  const selectedInstalled = selected?.installed
    ? inventory.packages.find(
        (pkg) =>
          pkg.source === selected.installed!.source &&
          pkg.scope === selected.installed!.scope,
      )
    : selected?.catalog
      ? installedFor(selected.catalog)
      : undefined;
  const currentSelected =
    selected &&
    (selectedInstalled || selected.catalog
      ? entry(selected.catalog, selectedInstalled)
      : null);
  const changeTab = (value: BrowseTab) => {
    setTab(value);
    setQuery("");
    setSearch("");
    setCategory("all");
  };
  const browseAll = () => changeTab("discover");
  const loading =
    tab === "discover" && (catalog.isPending || search !== query.trim());
  const failed = tab === "discover" && catalog.isError && !catalog.data;
  return (
    <VStack className="packages-marketplace" gap={6}>
      <HStack
        className="package-page-heading"
        hAlign="between"
        vAlign="center"
        gap={4}
      >
        <Text color="secondary">A toolkit that grows with you.</Text>
        <InstallPackageButton />
      </HStack>
      <PackageActionFeedback />
      <TabList
        value={tab}
        onChange={(value) => changeTab(value as BrowseTab)}
        hasDivider
      >
        <Tab value="discover" label="Discover" />
        <Tab
          value="installed"
          label={`Installed · ${inventory.packages.length}`}
        />
        <Tab
          value="updates"
          label={`Updates${actions.updatesLoading || actions.updatesError ? "" : ` · ${actions.updates.length}`}`}
        />
      </TabList>
      {tab === "discover" && !query && category === "all" && !failed && (
        <Spotlight onSearch={setQuery} />
      )}
      <VStack gap={4}>
        <HStack
          className="package-browse-heading"
          hAlign="between"
          vAlign="center"
          gap={4}
        >
          <VStack gap={1}>
            <Heading level={2}>
              {tab === "installed"
                ? "Your toolkit"
                : tab === "updates"
                  ? "Ready to update"
                  : "Find your next capability"}
            </Heading>
            <Text type="supporting">
              {loading
                ? "Loading packages…"
                : tab === "discover"
                  ? `${items.length} shown · ${catalog.data?.pages[0].total ?? 0} in the Pi community`
                  : `${items.length} packages`}
            </Text>
          </VStack>
          <VStack className="package-search-slot">
            <TextInput
              className="package-search"
              width="100%"
              label="Search packages"
              isLabelHidden
              placeholder="Search packages, capabilities, or authors…"
              startIcon={<Search />}
              value={query}
              onChange={setQuery}
              hasClear
              size="lg"
            />
          </VStack>
        </HStack>
        <HStack
          className="package-filter-row"
          hAlign="between"
          vAlign="center"
          gap={2}
        >
          <HStack
            gap={1}
            wrap="wrap"
            vAlign="center"
            aria-label="Resource types"
          >
            <Button
              label="All packages"
              size="sm"
              variant={category === "all" ? "secondary" : "ghost"}
              aria-pressed={category === "all"}
              onClick={() => setCategory("all")}
            />
            {kinds.map((kind) => (
              <Button
                key={kind}
                label={kindLabels[kind]}
                size="sm"
                variant={category === kind ? "secondary" : "ghost"}
                aria-pressed={category === kind}
                onClick={() => setCategory(kind)}
              />
            ))}
          </HStack>
          <Selector
            label="Sort packages"
            isLabelHidden
            size="sm"
            variant="ghost"
            value={sort}
            onChange={setSort}
            options={[
              {
                value: "relevance",
                label: tab === "discover" ? "Relevance" : "Default order",
              },
              { value: "name", label: "Name: A–Z" },
            ]}
          />
        </HStack>
        {tab === "discover" && (category !== "all" || sort === "name") && (
          <Text type="supporting">
            Types and sorting apply to loaded packages. Packages with unknown
            types appear under All packages.
          </Text>
        )}
        {loading ? (
          <EmptyState title="Loading the package catalogue…" />
        ) : failed ? (
          <EmptyState
            title="The package catalogue couldn’t load"
            description="Your installed packages are still available."
            icon={<Globe />}
            actions={
              <HStack gap={2}>
                <Button
                  label="Retry catalogue"
                  variant="primary"
                  onClick={() => void catalog.refetch()}
                />
                <Button
                  label="View installed"
                  onClick={() => changeTab("installed")}
                />
              </HStack>
            }
          />
        ) : tab === "updates" && actions.updatesLoading ? (
          <EmptyState title="Checking for updates…" />
        ) : tab === "updates" && actions.updatesError ? (
          <EmptyState
            title="Could not check for updates"
            description={actions.updatesError}
            actions={
              <Button
                label="Retry update check"
                onClick={actions.refreshUpdates}
              />
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Box />}
            title={
              query || category !== "all"
                ? "No packages match these filters"
                : tab === "updates"
                  ? "You’re all up to date"
                  : tab === "installed"
                    ? "Your toolkit starts here"
                    : "No packages found"
            }
            description="Try another search or browse all packages."
            actions={
              <Button
                label="Browse all packages"
                variant="primary"
                onClick={browseAll}
              />
            }
          />
        ) : (
          <Grid
            columns={{ minWidth: 250, max: 3 }}
            gap={4}
            className="package-grid"
          >
            {items.map((pkg) => (
              <Card key={pkg.key} padding={4} className="package-card">
                <VStack gap={4} style={{ height: "100%" }}>
                  <HStack gap={3} vAlign="center">
                    <Glyph pkg={pkg} />
                    <VStack gap={0.5} style={{ minWidth: 0, flex: 1 }}>
                      <Button
                        label={`View ${pkg.title}`}
                        className="package-title-button"
                        variant="ghost"
                        onClick={() => setSelected(pkg)}
                      >
                        {pkg.title}
                      </Button>
                      <Text type="supporting" maxLines={1} hasTruncateTooltip={false}>
                        {pkg.author
                          ? `by ${pkg.author}`
                          : pkg.installed
                            ? `${pkg.installed.scope} package`
                            : "Pi community"}
                      </Text>
                    </VStack>
                  </HStack>
                  <Text
                    className="package-card-description"
                    maxLines={3}
                    hasTruncateTooltip={false}
                  >
                    {pkg.description}
                  </Text>
                  <Text
                    className="package-card-source"
                    type="supporting"
                    maxLines={1}
                    hasTruncateTooltip={false}
                  >
                    {pkg.installed?.source ?? pkg.name}
                  </Text>
                  <HStack
                    gap={2}
                    hAlign="between"
                    vAlign="center"
                    style={{ marginTop: "auto" }}
                  >
                    <Text type="supporting">
                      {pkg.kinds.map((kind) => kindLabels[kind]).join(" · ") ||
                        (pkg.installed
                          ? "No resources loaded"
                          : "Types unknown")}
                    </Text>
                    <PackageAction
                      pkg={pkg}
                      onManage={() => setSelected(pkg)}
                    />
                  </HStack>
                </VStack>
              </Card>
            ))}
          </Grid>
        )}
        {tab === "discover" && catalog.data && catalog.isError && (
          <Text role="alert" style={{ color: "var(--danger)" }}>
            Could not load more packages: {catalog.error.message}
          </Text>
        )}
        {tab === "discover" && catalog.hasNextPage && !loading && (
          <Button
            label={
              catalog.isFetchingNextPage
                ? "Loading more…"
                : "Load more packages"
            }
            isDisabled={catalog.isFetchingNextPage}
            style={{ alignSelf: "center" }}
            onClick={() => void catalog.fetchNextPage()}
          />
        )}
      </VStack>
      <HStack
        className="package-footer"
        gap={2}
        wrap="wrap"
        hAlign="between"
        vAlign="center"
      >
        <Text type="supporting">Made for Pi. Shaped by its community.</Text>
        <HStack gap={2} wrap="wrap">
          <Button
            label="Add local resource"
            variant="ghost"
            size="sm"
            isDisabled={actions.pending}
            onClick={() => void actions.run("select_local_resource", {})}
          />
          <Button
            label="Resources & configuration"
            variant="ghost"
            size="sm"
            onClick={() => setInspector(true)}
          />
        </HStack>
      </HStack>
      {currentSelected && (
        <PackageDetail
          key={selected!.key}
          pkg={currentSelected}
          onClose={() => setSelected(null)}
        />
      )}
      {inspector && (
        <Dialog
          isOpen
          width="min(94vw, calc(var(--spacing-10) * 22))"
          maxHeight="85dvh"
          purpose="form"
          onOpenChange={setInspector}
        >
          <Layout
            header={
              <DialogHeader
                title="Resources & configuration"
                onOpenChange={setInspector}
              />
            }
            content={
              <LayoutContent>
                <VStack gap={4}>
                  <Text type="supporting">
                    Packages and resources from your Pi agent directory. Changes
                    apply to the next new Session.
                  </Text>
                  <HStack gap={2}>
                    <Button
                      label="Add local resource"
                      isDisabled={actions.pending}
                      onClick={() =>
                        void actions.run("select_local_resource", {})
                      }
                    />
                    <Button
                      label="Run environment check"
                      onClick={onEnvironmentCheck}
                    />
                  </HStack>
                  <PackageActionFeedback />
                  <SetupInventoryControls
                    selected={section}
                    onSelect={setSection}
                    inventory={inventory}
                    isFetching={refreshing}
                    onRefresh={onRefresh}
                  />
                  <ConfigInventoryView
                    inventory={inventory}
                    selected={section}
                  />
                </VStack>
              </LayoutContent>
            }
          />
        </Dialog>
      )}
    </VStack>
  );
}

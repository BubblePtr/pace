import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import {
  CheckboxList,
  CheckboxListItem,
} from "@astryxdesign/core/CheckboxList";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import {
  useSettingsDialog,
  type SettingsSection,
} from "@/shared/settings-navigation";
import {
  AnimatedFile,
  AnimatedInformationCircle,
  AnimatedKey,
  AnimatedMessage,
  AnimatedRobot,
} from "@/shared/ui/icons";
import { ChangelogSection } from "@/pages/settings-changelog";
import paceIcon from "../../../../build/icon-512.png";
import { ProviderIcon } from "@/entities/provider/provider-icon";
import {
  getVisibleModels,
  saveVisibleModels,
} from "@/entities/model/visible-models";
import { useUpdateStatus } from "@/entities/update/use-update-status";
import { isModelVisible } from "@/shared/ui/model-selector/model-selector-logic";
import { invoke, revealProjectInFinder } from "@/shared/runtime";
import type { UpdateStatus } from "@/shared/update-protocol";
import type {
  ProviderAuthId,
  ProviderAuthStatusItem,
  ProviderAuthStatusReport,
  RuntimeModelCapability,
  RuntimeModelControls,
} from "@pace/core";

export const providerAuthStatusQueryKey = ["provider-auth-status"] as const;
const availableModelControlsQueryKey = ["available-model-controls"] as const;

type AuthTab = "subscription" | "api_key";

async function listProviderAuthStatus() {
  return invoke<ProviderAuthStatusReport>("list_provider_auth_status");
}

function statusSummary(provider: ProviderAuthStatusItem) {
  if (!provider.configured || provider.mode === "none") {
    return "Not configured";
  }

  if (provider.mode === "oauth") {
    return provider.statusLabel
      ? `Subscription · ${provider.statusLabel}`
      : "Subscription connected";
  }

  if (provider.mode === "api_key") {
    return provider.keyHint
      ? `API key · ${provider.keyHint}`
      : "API key configured";
  }

  return "Configured";
}

function ProviderApiKeyCard({
  provider,
  onSaved,
}: {
  provider: ProviderAuthStatusItem;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saveMutation = useMutation({
    mutationFn: () =>
      invoke<ProviderAuthStatusReport>("set_provider_api_key", {
        providerId: provider.id,
        apiKey,
      }),
    onSuccess: () => {
      setApiKey("");
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });
  const removeMutation = useMutation({
    mutationFn: () =>
      invoke<ProviderAuthStatusReport>("remove_provider_auth", {
        providerId: provider.id,
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <Card data-testid={`provider-api-key-${provider.id}`}>
      <HStack gap={3} vAlign="start">
        <ProviderIcon providerId={provider.id} label={provider.label} />
        <VStack gap={1}>
          <Heading level={3}>{provider.label}</Heading>
          <Text as="p" type="supporting">
            {statusSummary(provider)}
          </Text>
        </VStack>
      </HStack>
      <VStack gap={3} style={{ marginBlockStart: "var(--spacing-4)" }}>
        <TextInput
          label={`${provider.label} API key`}
          isLabelHidden
          placeholder="Paste API key"
          type="password"
          value={apiKey}
          onChange={(value) => setApiKey(value)}
        />
        <HStack gap={2} wrap="wrap">
          <Button
            variant="primary"
            label={
              provider.configured && provider.mode === "api_key"
                ? "Replace key"
                : "Save key"
            }
            isDisabled={!apiKey.trim() || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          />
          {provider.configured ? (
            <Button
              variant="destructive"
              label="Remove"
              isDisabled={removeMutation.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Remove credentials for ${provider.label}? This cannot be undone from the UI.`,
                  )
                ) {
                  removeMutation.mutate();
                }
              }}
            />
          ) : null}
        </HStack>
        {error ? (
          <Text
            as="p"
            type="supporting"
            role="alert"
            style={{ color: "var(--danger)" }}
          >
            {error}
          </Text>
        ) : null}
      </VStack>
    </Card>
  );
}

function ProviderSubscriptionCard({
  provider,
  onSaved,
}: {
  provider: ProviderAuthStatusItem;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const loginMutation = useMutation({
    mutationFn: () =>
      invoke<ProviderAuthStatusReport>("login_provider_oauth", {
        providerId: provider.id,
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });
  const logoutMutation = useMutation({
    mutationFn: () =>
      invoke<ProviderAuthStatusReport>("logout_provider_auth", {
        providerId: provider.id,
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <Card data-testid={`provider-subscription-${provider.id}`}>
      <HStack gap={3} vAlign="start">
        <ProviderIcon providerId={provider.id} label={provider.label} />
        <VStack gap={1}>
          <Heading level={3}>{provider.label}</Heading>
          <Text as="p" type="supporting">
            {statusSummary(provider)}
          </Text>
        </VStack>
      </HStack>
      <VStack gap={3} style={{ marginBlockStart: "var(--spacing-4)" }}>
        <HStack gap={2} wrap="wrap">
          {provider.mode === "oauth" ? (
            <Button
              variant="destructive"
              label="Logout"
              isDisabled={logoutMutation.isPending}
              onClick={() => {
                if (
                  window.confirm(`Log out of ${provider.label} subscription?`)
                ) {
                  logoutMutation.mutate();
                }
              }}
            />
          ) : (
            <Button
              variant="primary"
              label={
                loginMutation.isPending
                  ? "Waiting for browser…"
                  : "Login with subscription"
              }
              isDisabled={loginMutation.isPending}
              onClick={() => loginMutation.mutate()}
            />
          )}
        </HStack>
        {error ? (
          <Text
            as="p"
            type="supporting"
            role="alert"
            style={{ color: "var(--danger)" }}
          >
            {error}
          </Text>
        ) : null}
      </VStack>
    </Card>
  );
}

function groupModelsByProvider(models: RuntimeModelCapability[]) {
  const groups = new Map<string, RuntimeModelCapability[]>();

  for (const model of models) {
    const group = groups.get(model.provider);

    if (group) {
      group.push(model);
    } else {
      groups.set(model.provider, [model]);
    }
  }

  return Array.from(groups, ([provider, providerModels]) => ({
    provider,
    models: providerModels,
  }));
}

/**
 * Which catalog models the composer selector may offer (issue #102). Stored
 * per install, read by the selector; an empty set means "not configured" and
 * lists everything, which is also what unchecking the last model falls back to.
 */
function ModelVisibilitySection({
  models,
  isLoading,
  errorMessage,
  providerLabels,
}: {
  models: RuntimeModelCapability[];
  isLoading: boolean;
  errorMessage?: string;
  providerLabels: Record<string, string>;
}) {
  const [visibleModels, setVisibleModels] = useState(getVisibleModels);

  // The checkboxes show what the selector will actually list, so they run
  // through the same predicate — including its "unconfigured means all" rule.
  // Persisting from this set also drops entries the catalog no longer has.
  const checkedModels = models.filter((model) =>
    isModelVisible(model, visibleModels),
  );

  const replaceProviderSelection = (provider: string, modelIds: string[]) => {
    const next = [
      ...checkedModels
        .filter((model) => model.provider !== provider)
        .map(({ provider: keptProvider, modelId }) => ({
          provider: keptProvider,
          modelId,
        })),
      ...modelIds.map((modelId) => ({ provider, modelId })),
    ];

    setVisibleModels(next);
    saveVisibleModels(next);
  };

  return (
    <VStack
      as="section"
      aria-labelledby="settings-models-heading"
      gap={3}
      id="models"
    >
      <VStack gap={2}>
        <Heading level={2} id="settings-models-heading">
          Models
        </Heading>
        <Text as="p" type="supporting">
          Choose which models the composer model selector offers. With none
          selected, every available model is shown.
        </Text>
      </VStack>

      {isLoading ? (
        <Text as="p" type="supporting">
          Loading…
        </Text>
      ) : null}
      {errorMessage ? (
        <Text
          as="p"
          type="supporting"
          role="alert"
          style={{ color: "var(--danger)" }}
        >
          {errorMessage}
        </Text>
      ) : null}
      {!isLoading && !errorMessage && models.length === 0 ? (
        <Text as="p" type="supporting">
          No models are available yet. Configure a provider in Providers first.
        </Text>
      ) : null}

      {groupModelsByProvider(models).map((group) => {
        const label = providerLabels[group.provider] ?? group.provider;

        return (
          <Card
            data-testid={`model-visibility-${group.provider}`}
            key={group.provider}
          >
            <HStack gap={3} vAlign="center">
              <ProviderIcon providerId={group.provider} label={label} />
              <Heading level={3}>{label}</Heading>
            </HStack>
            <VStack style={{ marginBlockStart: "var(--spacing-4)" }}>
              <CheckboxList
                hasDividers
                isLabelHidden
                label={`${label} models`}
                width="100%"
                value={group.models
                  .filter((model) => isModelVisible(model, visibleModels))
                  .map((model) => model.modelId)}
                onChange={(modelIds) =>
                  replaceProviderSelection(group.provider, modelIds)
                }
              >
                {group.models.map((model) => (
                  <CheckboxListItem
                    description={model.modelId}
                    key={model.modelId}
                    label={model.name}
                    // The checkbox conveys visibility; a row fill implies navigation selection.
                    style={{ backgroundColor: "transparent" }}
                    value={model.modelId}
                  />
                ))}
              </CheckboxList>
            </VStack>
          </Card>
        );
      })}
    </VStack>
  );
}

function updateStatusText(status: UpdateStatus) {
  switch (status.state) {
    case "disabled":
      return status.reason ?? "Updates are unavailable in this build.";
    case "idle":
      return "You're up to date.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return status.availableVersion
        ? `Version ${status.availableVersion} is available.`
        : "An update is available.";
    case "downloading":
      return typeof status.progressPercent === "number"
        ? `Downloading update… ${Math.round(status.progressPercent)}%`
        : "Downloading update…";
    case "ready":
      return status.availableVersion
        ? `Version ${status.availableVersion} is ready to install.`
        : "An update is ready to install.";
    case "error":
      return status.message ?? "Could not check for updates.";
  }
}

function AboutUpdatesSection() {
  const status = useUpdateStatus();
  const checkMutation = useMutation({
    mutationFn: () => invoke("update:check"),
  });
  const installMutation = useMutation({
    mutationFn: () => invoke("update:install"),
  });

  return (
    <VStack
      as="section"
      aria-labelledby="settings-about-heading"
      gap={3}
      data-testid="settings-about"
    >
      <VStack gap={2}>
        <Heading level={2} id="settings-about-heading">
          About & Updates
        </Heading>
        <HStack gap={3} vAlign="center">
          <img src={paceIcon} alt="" className="size-20 shrink-0" />
          <VStack gap={1}>
            <Heading level={3}>Pace Agent</Heading>
            <Text as="p" type="supporting">
              {status ? `Version ${status.currentVersion}` : "Loading version…"}
            </Text>
          </VStack>
        </HStack>
        {status ? (
          <Text
            as="p"
            type="supporting"
            style={
              status.state === "error" ? { color: "var(--danger)" } : undefined
            }
          >
            {updateStatusText(status)}
          </Text>
        ) : null}
      </VStack>
      <Card>
        <HStack gap={2} wrap="wrap">
          <Button
            variant="primary"
            label="Check for updates"
            isDisabled={
              !status ||
              status.state === "disabled" ||
              status.state === "checking" ||
              checkMutation.isPending
            }
            onClick={() => checkMutation.mutate()}
          />
          {status?.state === "ready" ? (
            <Button
              variant="primary"
              label="Restart to update"
              isDisabled={installMutation.isPending}
              onClick={() => installMutation.mutate()}
            />
          ) : null}
        </HStack>
      </Card>
    </VStack>
  );
}

function ChatsSettingsSection({ enabled }: { enabled: boolean }) {
  const rootQuery = useQuery({
    queryKey: ["chat-workspace-root"],
    queryFn: () => invoke<{ path: string }>("get_chat_workspace_root"),
    enabled,
  });
  const path = rootQuery.data?.path ?? "";

  return (
    <VStack
      as="section"
      aria-labelledby="settings-chats-heading"
      gap={3}
      data-testid="settings-chats"
    >
      <VStack gap={2}>
        <Heading level={2} id="settings-chats-heading">
          Chats
        </Heading>
        <Text as="p" type="supporting">
          Each Chat Session works in its own folder under this directory.
        </Text>
      </VStack>
      <Card>
        <VStack gap={3}>
          <Text as="p" type="supporting">
            {rootQuery.isPending ? "Loading…" : path || "Chat workspace path unavailable."}
          </Text>
          <Button
            variant="secondary"
            label="Open folder"
            isDisabled={!path}
            onClick={() => {
              void revealProjectInFinder(path, { ensure: true });
            }}
          />
        </VStack>
      </Card>
    </VStack>
  );
}

function SettingsContent({
  section,
  onSectionChange,
  onClose,
  compact,
}: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  compact: boolean;
}) {
  const queryClient = useQueryClient();
  const updateStatus = useUpdateStatus();
  const updateIndicator =
    updateStatus?.state === "ready" ? (
      <Token
        size="sm"
        color="green"
        label="Ready"
        description="Update ready to install"
      />
    ) : updateStatus?.state === "available" || updateStatus?.state === "downloading" ? (
      <Token
        size="sm"
        color="blue"
        label="Update"
        description="Update available"
      />
    ) : undefined;
  const [tab, setTab] = useState<AuthTab>("subscription");
  const [apiKeyFilter, setApiKeyFilter] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);
  const statusQuery = useQuery({
    queryKey: providerAuthStatusQueryKey,
    queryFn: listProviderAuthStatus,
  });

  const providers = statusQuery.data?.providers ?? [];
  const subscriptionProviders = useMemo(
    () => providers.filter((provider) => provider.supportsOAuth),
    [providers],
  );
  const visibleApiKeyProviders = useMemo(() => {
    const query = apiKeyFilter.trim().toLowerCase();
    return providers.filter((provider) => {
      if (!provider.supportsApiKey) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        provider.label.toLowerCase().includes(query) ||
        provider.id.toLowerCase().includes(query)
      );
    });
  }, [apiKeyFilter, providers]);

  const providerLabels = useMemo(
    () =>
      Object.fromEntries(
        providers.map((provider) => [provider.id, provider.label]),
      ),
    [providers],
  );
  const modelsQuery = useQuery({
    queryKey: availableModelControlsQueryKey,
    queryFn: () =>
      invoke<RuntimeModelControls>("list_available_model_controls"),
  });
  const modelCatalogError = !modelsQuery.isError
    ? undefined
    : modelsQuery.error instanceof Error
      ? modelsQuery.error.message
      : "Could not load the model catalog.";

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: providerAuthStatusQueryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: ["environment-preflight-report"],
    });
    // New credentials change which models Pi offers, so refresh the catalog too.
    void queryClient.invalidateQueries({
      queryKey: availableModelControlsQueryKey,
    });
  };

  return (
    <Layout
      padding={4}
      style={{
        height: compact ? "100dvh" : "min(85dvh, calc(var(--spacing-10) * 17))",
      }}
      header={
        <VStack gap={0}>
          <DialogHeader title="Settings" onOpenChange={onClose} hasDivider />
          {compact ? (
            <TabList
              aria-label="Settings sections"
              value={section}
              onChange={(value) => onSectionChange(value as SettingsSection)}
              layout="fill"
              hasDivider
            >
              {settingsSections.map((item) => (
                <Tab
                  key={item.id}
                  value={item.id}
                  label={item.id === "about" ? "About" : item.label}
                  endContent={item.id === "about" ? updateIndicator : undefined}
                  style={{
                    paddingInline: "var(--spacing-2)",
                    height: updateIndicator
                      ? "calc(var(--spacing-8) * 2)"
                      : undefined,
                    flexDirection: "column",
                    gap: "var(--spacing-1)",
                  }}
                />
              ))}
            </TabList>
          ) : null}
        </VStack>
      }
      start={
        compact ? undefined : (
          <LayoutPanel
            padding={2}
            width="calc(var(--spacing-10) * 7)"
            hasDivider
          >
            <SideNav aria-label="Settings sections" style={{ width: "100%" }}>
              <VStack gap={1}>
                {settingsSections.map(({ id, label, icon: Icon }) => (
                  <SideNavItem
                    key={id}
                    label={label}
                    endContent={id === "about" ? updateIndicator : undefined}
                    icon={
                      <Icon
                        aria-hidden="true"
                        style={{
                          width: "var(--spacing-4)",
                          height: "var(--spacing-4)",
                        }}
                      />
                    }
                    isSelected={section === id}
                    onClick={() => onSectionChange(id)}
                  />
                ))}
              </VStack>
            </SideNav>
          </LayoutPanel>
        )
      }
    >
      <LayoutContent ref={contentRef} padding={compact ? 4 : 6}>
        <VStack gap={6}>
          <VStack
            style={{ display: section === "providers" ? undefined : "none" }}
          >
            <VStack
              as="section"
              aria-labelledby="settings-providers-heading"
              gap={3}
            >
              <VStack gap={2}>
                <Heading level={2} id="settings-providers-heading">
                  Providers
                </Heading>
                <Text as="p" type="supporting">
                  Configure model credentials. Keys are stored in Pi{" "}
                  <code>auth.json</code> and never shown in full after save.
                </Text>
                {statusQuery.data ? (
                  <Text as="p" type="supporting">
                    {statusQuery.data.configuredCount} provider
                    {statusQuery.data.configuredCount === 1 ? "" : "s"}{" "}
                    configured
                  </Text>
                ) : null}
              </VStack>

              <VStack>
                <TabList
                  hasDivider
                  value={tab}
                  onChange={(value) => {
                    if (value === "subscription" || value === "api_key") {
                      setTab(value);
                    }
                  }}
                >
                  <Tab value="subscription" label="Subscription" />
                  <Tab value="api_key" label="API Key" />
                </TabList>
                {tab === "subscription" ? (
                  <VStack
                    gap={3}
                    style={{ marginBlockStart: "var(--spacing-4)" }}
                  >
                    <Text as="p" type="supporting">
                      Log in with a provider subscription via Pi OAuth
                      (browser). Uses the same Pi <code>auth.json</code> as the
                      local TUI.
                    </Text>
                    {statusQuery.isLoading ? (
                      <Text as="p" type="supporting">
                        Loading…
                      </Text>
                    ) : (
                      subscriptionProviders.map((provider) => (
                        <ProviderSubscriptionCard
                          key={provider.id}
                          provider={provider}
                          onSaved={refresh}
                        />
                      ))
                    )}
                  </VStack>
                ) : (
                  <VStack
                    gap={3}
                    style={{ marginBlockStart: "var(--spacing-4)" }}
                  >
                    <Text as="p" type="supporting">
                      Paste an API key for a provider that accepts one.
                    </Text>
                    <TextInput
                      label="Filter providers"
                      isLabelHidden
                      placeholder="Filter providers"
                      value={apiKeyFilter}
                      onChange={setApiKeyFilter}
                      width="100%"
                    />
                    {statusQuery.isLoading ? (
                      <Text as="p" type="supporting">
                        Loading…
                      </Text>
                    ) : (
                      visibleApiKeyProviders.map((provider) => (
                        <ProviderApiKeyCard
                          key={provider.id}
                          provider={provider}
                          onSaved={refresh}
                        />
                      ))
                    )}
                  </VStack>
                )}
              </VStack>

              {statusQuery.isError ? (
                <Text
                  as="p"
                  type="supporting"
                  role="alert"
                  style={{ color: "var(--danger)" }}
                >
                  {statusQuery.error instanceof Error
                    ? statusQuery.error.message
                    : "Could not load provider status."}
                </Text>
              ) : null}
            </VStack>
          </VStack>
          <VStack
            style={{ display: section === "models" ? undefined : "none" }}
          >
            <ModelVisibilitySection
              errorMessage={modelCatalogError}
              isLoading={modelsQuery.isPending}
              models={modelsQuery.data?.models ?? []}
              providerLabels={providerLabels}
            />
          </VStack>
          <VStack
            style={{ display: section === "chats" ? undefined : "none" }}
          >
            <ChatsSettingsSection enabled={section === "chats"} />
          </VStack>
          <VStack style={{ display: section === "changelog" ? undefined : "none" }}>
            <ChangelogSection />
          </VStack>
          <VStack style={{ display: section === "about" ? undefined : "none" }}>
            <AboutUpdatesSection />
          </VStack>
        </VStack>
      </LayoutContent>
    </Layout>
  );
}

const settingsSections = [
  { id: "providers", label: "Providers", icon: AnimatedKey },
  { id: "models", label: "Models", icon: AnimatedRobot },
  { id: "chats", label: "Chats", icon: AnimatedMessage },
  { id: "changelog", label: "Changelog", icon: AnimatedFile },
  { id: "about", label: "About & Updates", icon: AnimatedInformationCircle },
] as const;

export function SettingsDialog() {
  const { section, openSettings, closeSettings } = useSettingsDialog();
  const compact = useMediaQuery("(max-width: 640px)");
  const isOpen = section !== null;
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // DialogHeader focuses its title in a passive effect before Dialog records
  // the opener. Capture it during layout, then restore after Dialog closes.
  useLayoutEffect(() => {
    if (isOpen)
      returnFocusRef.current = document.activeElement as HTMLElement | null;
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [isOpen]);

  return (
    <Dialog
      aria-label="Settings"
      data-testid="settings-dialog"
      isOpen={isOpen}
      onOpenChange={(isOpen) => {
        if (!isOpen) closeSettings();
      }}
      purpose="form"
      width="calc(var(--spacing-10) * 22)"
      maxHeight="90dvh"
      variant={compact ? "fullscreen" : "standard"}
      padding={4}
    >
      {section ? (
        <SettingsContent
          section={section}
          onSectionChange={openSettings}
          onClose={closeSettings}
          compact={compact}
        />
      ) : null}
    </Dialog>
  );
}

export type { ProviderAuthId };

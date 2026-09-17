import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { StackItem } from "@astryxdesign/core/Stack";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  Globe,
  LinkExternal,
  RefreshCw,
  Trash2,
} from "@/shared/ui/icons";
import {
  SessionSurfaceBar,
  SessionSurfaceTabs,
  type SessionSurfaceTabItem,
} from "@/shared/ui/session-dock/surface-bar";
import { describeLoadError } from "./describe-load-error";

/**
 * Chrome for the embedded browser surface: an address band plus the region the
 * native `WebContentsView` paints behind.
 *
 * The component owns no view — it renders a placeholder whose rect the panel
 * pushes to the main process. That is why every non-live state deliberately
 * drops the placeholder: no placeholder, no bounds, no native view painting
 * where it must not (the Sheet fallback below the dock breakpoint, and the
 * error state where Chromium's own error page would show instead of ours).
 */
export type BrowserSurfaceState =
  | { kind: "narrow" }
  | { kind: "unsupported" }
  | { kind: "empty"; phase?: "idle" | "initializing" | "opening" }
  // A tab exists but has not navigated anywhere yet — distinct from "empty"
  // (no tabs at all), since it still shows the tab strip and address bar.
  | { kind: "blank" }
  | { kind: "live" }
  | { kind: "error"; message: string };

type BrowserSurfaceContextValue = {
  state: BrowserSurfaceState;
};

const BrowserSurfaceContext = createContext<BrowserSurfaceContextValue | null>(null);

function useBrowserSurfaceContext(component: string) {
  const value = useContext(BrowserSurfaceContext);
  if (!value) {
    throw new Error(`${component} must be used within BrowserSurface`);
  }
  return value;
}

function showsBrowserChrome(state: BrowserSurfaceState) {
  if (state.kind === "narrow" || state.kind === "unsupported") {
    return false;
  }
  return state.kind !== "empty";
}

type BrowserSurfaceOwnProps = {
  state: BrowserSurfaceState;
  children?: ReactNode;
};

export type BrowserSurfaceProps = Omit<ComponentProps<"div">, keyof BrowserSurfaceOwnProps> &
  BrowserSurfaceOwnProps;

export function BrowserSurface({
  state,
  children,
  className,
  ...rest
}: BrowserSurfaceProps) {
  return (
    <BrowserSurfaceContext.Provider value={{ state }}>
      <div
        className={`flex h-full min-h-0 flex-col ${className ?? ""}`.trim()}
        data-slot="browser-surface"
        {...rest}
      >
        {children}
      </div>
    </BrowserSurfaceContext.Provider>
  );
}

type BrowserSurfaceTabsOwnProps = {
  tabs: readonly SessionSurfaceTabItem[];
  activeTabId: string | null;
  onActiveTabChange: (id: string) => void;
  onAddTab: () => void;
  onCloseTab: (id: string) => void;
  annotationCount: number;
};

export type BrowserSurfaceTabsProps = Omit<
  ComponentProps<"div">,
  keyof BrowserSurfaceTabsOwnProps | "children"
> &
  BrowserSurfaceTabsOwnProps;

function BrowserSurfaceTabs({
  tabs,
  activeTabId,
  onActiveTabChange,
  onAddTab,
  onCloseTab,
  annotationCount,
  className,
  ...rest
}: BrowserSurfaceTabsProps) {
  const { state } = useBrowserSurfaceContext("BrowserSurface.Tabs");
  const isLive = state.kind === "live";

  if (!showsBrowserChrome(state) || tabs.length === 0) {
    return null;
  }

  return (
    <SessionSurfaceBar
      actions={
        isLive && annotationCount > 0 ? (
          <span
            className="shrink-0 text-xs tabular-nums text-muted"
            data-testid="browser-annotation-count"
          >
            {annotationCount} marked
          </span>
        ) : null
      }
      className={className}
      {...rest}
    >
      <SessionSurfaceTabs
        activeId={activeTabId}
        addLabel="New browser tab"
        icon={Globe}
        items={tabs}
        aria-label="Browser instances"
        onActiveChange={onActiveTabChange}
        onAdd={onAddTab}
        onClose={onCloseTab}
      />
    </SessionSurfaceBar>
  );
}

type BrowserSurfaceToolbarOwnProps = {
  address: string;
  isLoading?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isDesignMode: boolean;
  isSending?: boolean;
  annotationCount: number;
  onAddressChange: (address: string) => void;
  onAddressSubmit: (address: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
  onClearAnnotations: () => void;
  onDesignModeChange: (isDesignMode: boolean) => void;
  onSendToComposer: () => void;
};

export type BrowserSurfaceToolbarProps = Omit<
  ComponentProps<"div">,
  keyof BrowserSurfaceToolbarOwnProps | "children"
> &
  BrowserSurfaceToolbarOwnProps;

function BrowserSurfaceToolbar({
  address,
  isLoading,
  canGoBack,
  canGoForward,
  isDesignMode,
  isSending,
  annotationCount,
  onAddressChange,
  onAddressSubmit,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
  onClearAnnotations,
  onDesignModeChange,
  onSendToComposer,
  className,
  ...rest
}: BrowserSurfaceToolbarProps) {
  const { state } = useBrowserSurfaceContext("BrowserSurface.Toolbar");
  const isLive = state.kind === "live";

  if (!showsBrowserChrome(state)) {
    return null;
  }

  return (
    <SessionSurfaceBar
      actions={
        <>
          {/* Plain buttons only. Anything that opens a layer — Popover,
              Tooltip, Select — would trip the overlay detection and freeze
              the page into a still, leaving the user marking up a
              screenshot. */}
          <ToggleButton
            isIconOnly
            icon={<Crosshair className="size-4" />}
            isDisabled={!isLive}
            // Nothing can be marked where no page is live, so the toggle
            // never reads as pressed there — a pressed, disabled control
            // claims a state the user cannot leave.
            isPressed={isLive && isDesignMode}
            label="Design"
            size="sm"
            onPressedChange={onDesignModeChange}
          />
          <IconButton
            icon={<Trash2 className="size-4" />}
            isDisabled={!isLive || annotationCount === 0}
            label="Clear marks"
            size="sm"
            variant="ghost"
            onClick={onClearAnnotations}
          />
          {/* The action design mode exists for, so it is the one control
              here that carries its own label. Nothing to send without a
              mark: the prompt would be a URL and a screenshot with no
              question on it. */}
          <Button
            // Disabled while one is in flight: the page has to settle its
            // overlay before the shot, and a second click during that would
            // paste the block into the draft twice. Astryx only dedupes
            // `clickAction`, and that is a layer-free promise this button
            // cannot use.
            isDisabled={!isLive || annotationCount === 0 || isSending}
            label="Send to composer"
            size="sm"
            onClick={onSendToComposer}
          >
            To composer
          </Button>
          <IconButton
            icon={<LinkExternal className="size-4" />}
            isDisabled={!isLive}
            label="Open in default browser"
            size="sm"
            variant="ghost"
            onClick={onOpenExternal}
          />
        </>
      }
      className={className}
      {...rest}
    >
      <IconButton
        icon={<ArrowLeft className="size-4" />}
        isDisabled={!canGoBack}
        label="Back"
        size="sm"
        variant="ghost"
        onClick={onBack}
      />
      <IconButton
        icon={<ArrowRight className="size-4" />}
        isDisabled={!canGoForward}
        label="Forward"
        size="sm"
        variant="ghost"
        onClick={onForward}
      />
      <IconButton
        icon={<RefreshCw className="size-4" />}
        label="Reload"
        size="sm"
        variant="ghost"
        onClick={onReload}
      />
      <StackItem size="fill">
        <TextInput
          isLabelHidden
          isLoading={isLoading}
          label="Address"
          placeholder="localhost:5173"
          size="sm"
          value={address}
          width="100%"
          onChange={onAddressChange}
          onEnter={() => onAddressSubmit(address)}
        />
      </StackItem>
    </SessionSurfaceBar>
  );
}

type BrowserSurfaceViewportOwnProps = {
  viewportRef?: Ref<HTMLDivElement>;
  snapshot?: string | null;
  notice?: string | null;
  onAddTab?: () => void;
  onReload?: () => void;
};

export type BrowserSurfaceViewportProps = Omit<
  ComponentProps<"div">,
  keyof BrowserSurfaceViewportOwnProps | "children"
> &
  BrowserSurfaceViewportOwnProps;

function BrowserSurfaceViewport({
  viewportRef,
  snapshot,
  notice,
  onAddTab,
  onReload,
  className,
  ...rest
}: BrowserSurfaceViewportProps) {
  const { state } = useBrowserSurfaceContext("BrowserSurface.Viewport");
  const showNotice = state.kind !== "narrow" && state.kind !== "unsupported" && notice;

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className ?? ""}`.trim()} {...rest}>
      {showNotice ? (
        // Its own line rather than a layer or a toast: the native view covers
        // anything that floats, and this has to be readable next to the page
        // it is about.
        <p
          className="shrink-0 pb-1.5 text-xs text-muted"
          data-testid="browser-surface-notice"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">{renderViewportBody(state, { viewportRef, snapshot, onAddTab, onReload })}</div>
    </div>
  );
}

function renderViewportBody(
  state: BrowserSurfaceState,
  {
    viewportRef,
    snapshot,
    onAddTab,
    onReload,
  }: Pick<BrowserSurfaceViewportOwnProps, "viewportRef" | "snapshot" | "onAddTab" | "onReload">,
) {
  switch (state.kind) {
    case "narrow":
      return (
        <EmptyState
          className="h-full justify-center px-4"
          description="A native browser view cannot sit inside the Sheet fallback, so the browser needs the docked layout."
          icon={<Globe className="size-5 text-muted" />}
          isCompact
          title="Widen the window to use the browser"
        />
      );
    case "unsupported":
      return (
        <EmptyState
          className="h-full justify-center px-4"
          icon={<Globe className="size-5 text-muted" />}
          isCompact
          title="Browser requires the desktop app."
        />
      );
    case "blank":
      return (
        <EmptyState
          className="h-full justify-center px-4"
          description="Enter the address of a running dev server to preview it here."
          icon={<Globe className="size-5 text-muted" />}
          isCompact
          title="No page loaded"
        />
      );
    case "empty":
      return (
        <EmptyState
          style={{
            height: "100%",
            justifyContent: "center",
            paddingInline: "var(--spacing-4)",
          }}
          title={state.phase === "initializing" ? "Loading browser…" : "No browser tabs open"}
          description="Open the browser to preview a website."
          icon={<Globe className="size-5 text-muted" />}
          isCompact
          actions={
            state.phase === "initializing" ? undefined : (
              <Button
                label="Open browser"
                size="sm"
                isLoading={state.phase === "opening"}
                onClick={onAddTab}
              />
            )
          }
        />
      );
    case "error": {
      // Chromium hands us its raw net-error code (e.g. ERR_CONNECTION_REFUSED);
      // translate it to plain English but keep the code visible for anyone
      // who wants to search or report it.
      const { humanText, rawCode } = describeLoadError(state.message);
      const description =
        humanText === rawCode ? humanText : `${humanText} (${rawCode})`;
      return (
        <EmptyState
          actions={<Button label="Retry" size="sm" onClick={onReload} />}
          className="h-full justify-center px-4"
          description={description}
          icon={<Globe className="size-5 text-muted" />}
          isCompact
          title="The page did not load"
        />
      );
    }
    case "live":
      // Empty unless a DOM overlay is up: the native view paints over this
      // rect, and its bounds are this element's own `getBoundingClientRect()`.
      // While an overlay needs to be visible the native view steps aside and
      // this still of the page stands in for it, filling the same rect so
      // nothing shifts.
      return (
        <div
          className="h-full w-full"
          data-testid="browser-viewport"
          ref={viewportRef}
        >
          {snapshot ? (
            <img
              alt=""
              className="h-full w-full"
              data-testid="browser-snapshot"
              src={snapshot}
              style={{ objectFit: "fill" }}
            />
          ) : null}
        </div>
      );
  }
}

BrowserSurface.Tabs = BrowserSurfaceTabs;
BrowserSurface.Toolbar = BrowserSurfaceToolbar;
BrowserSurface.Viewport = BrowserSurfaceViewport;

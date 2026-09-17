import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserSurface,
  type BrowserSurfaceState,
} from "@/shared/ui/browser/browser-surface";
import type { SessionSurfaceTabItem } from "@/shared/ui/session-dock/surface-bar";

type SurfaceHarness = {
  tabs: readonly SessionSurfaceTabItem[];
  activeTabId: string | null;
  onActiveTabChange: (id: string) => void;
  onAddTab: () => void;
  onCloseTab: (id: string) => void;
  address: string;
  state: BrowserSurfaceState;
  canGoBack: boolean;
  canGoForward: boolean;
  annotationCount: number;
  isDesignMode: boolean;
  isLoading?: boolean;
  isSending?: boolean;
  notice?: string | null;
  snapshot?: string | null;
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

function surfaceProps(overrides: Partial<SurfaceHarness> = {}): SurfaceHarness {
  return {
    tabs: [
      { id: "a", label: "Browser 1" },
      { id: "b", label: "Browser 2" },
    ],
    activeTabId: "a",
    onActiveTabChange: vi.fn(),
    onAddTab: vi.fn(),
    onCloseTab: vi.fn(),
    address: "",
    state: { kind: "live" },
    canGoBack: false,
    canGoForward: false,
    annotationCount: 0,
    isDesignMode: false,
    onAddressChange: vi.fn(),
    onAddressSubmit: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onOpenExternal: vi.fn(),
    onClearAnnotations: vi.fn(),
    onDesignModeChange: vi.fn(),
    onSendToComposer: vi.fn(),
    ...overrides,
  };
}

function ComposedBrowserSurface(props: SurfaceHarness) {
  return (
    <BrowserSurface state={props.state}>
      <BrowserSurface.Tabs
        tabs={props.tabs}
        activeTabId={props.activeTabId}
        annotationCount={props.annotationCount}
        onActiveTabChange={props.onActiveTabChange}
        onAddTab={props.onAddTab}
        onCloseTab={props.onCloseTab}
      />
      <BrowserSurface.Toolbar
        address={props.address}
        annotationCount={props.annotationCount}
        canGoBack={props.canGoBack}
        canGoForward={props.canGoForward}
        isDesignMode={props.isDesignMode}
        isLoading={props.isLoading}
        isSending={props.isSending}
        onAddressChange={props.onAddressChange}
        onAddressSubmit={props.onAddressSubmit}
        onBack={props.onBack}
        onClearAnnotations={props.onClearAnnotations}
        onDesignModeChange={props.onDesignModeChange}
        onForward={props.onForward}
        onOpenExternal={props.onOpenExternal}
        onReload={props.onReload}
        onSendToComposer={props.onSendToComposer}
      />
      <BrowserSurface.Viewport
        notice={props.notice}
        snapshot={props.snapshot}
        onAddTab={props.onAddTab}
        onReload={props.onReload}
      />
    </BrowserSurface>
  );
}

function renderSurface(overrides: Partial<SurfaceHarness> = {}) {
  const props = surfaceProps(overrides);

  render(<ComposedBrowserSurface {...props} />);

  return props;
}

describe("BrowserSurface", () => {
  it("puts shared instance tabs first and page controls in the next row", async () => {
    const props = renderSurface({ address: "localhost:5173" });
    const [tabs, controls] = screen.getAllByTestId("session-surface-bar");
    expect(tabs).toHaveClass("h-10");
    expect(
      within(tabs!).getByRole("tablist", { name: "Browser instances" }),
    ).toBeInTheDocument();
    expect(within(tabs!).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(controls!).getByRole("textbox", { name: "Address" }),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Browser 2" }));
    expect(props.onActiveTabChange).toHaveBeenCalledWith("b");
    await user.click(screen.getByRole("button", { name: "Close Browser 1" }));
    expect(props.onCloseTab).toHaveBeenCalledWith("a");
    await user.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(props.onAddTab).toHaveBeenCalledTimes(1);
  });

  it("shows only an explicit create action when there are no tabs", async () => {
    const user = userEvent.setup();
    const props = renderSurface({ tabs: [], activeTabId: null, state: { kind: "empty" } });

    expect(screen.getByText("No browser tabs open")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByTestId("browser-viewport")).not.toBeInTheDocument();
    expect(props.onAddTab).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open browser" }));
    expect(props.onAddTab).toHaveBeenCalledTimes(1);
  });

  it("withholds creation during initialization and disables it while opening", async () => {
    const user = userEvent.setup();
    const props = surfaceProps({ tabs: [], activeTabId: null, state: { kind: "empty", phase: "initializing" } });
    const view = render(<ComposedBrowserSurface {...props} />);
    expect(screen.getByText("Loading browser…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    view.rerender(
      <ComposedBrowserSurface {...props} state={{ kind: "empty", phase: "opening" }} />,
    );
    const open = screen.getByRole("button", { name: "Open browser" });
    expect(open).toBeDisabled();
    await user.click(open);
    expect(props.onAddTab).not.toHaveBeenCalled();
  });

  it("renders no first row where there is no chrome to put in it", () => {
    renderSurface({ state: { kind: "unsupported" } });

    expect(screen.queryByTestId("session-surface-bar")).not.toBeInTheDocument();
  });

  it("submits the typed address on Enter", async () => {
    const user = userEvent.setup();
    const onAddressSubmit = vi.fn();

    renderSurface({ address: "localhost:5173", onAddressSubmit });

    await user.click(screen.getByRole("textbox", { name: "Address" }));
    await user.keyboard("{Enter}");

    expect(onAddressSubmit).toHaveBeenCalledWith("localhost:5173");
  });

  it("disables history controls the page cannot use", () => {
    renderSurface({ canGoBack: true, canGoForward: false });

    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("renders no viewport placeholder below the dock breakpoint", () => {
    renderSurface({ state: { kind: "narrow" } });

    // The placeholder is what drives the native view's bounds. Rendering one
    // inside the Sheet fallback would paint the native view over the overlay.
    expect(screen.queryByTestId("browser-viewport")).not.toBeInTheDocument();
    expect(screen.getByText(/widen the window/i)).toBeInTheDocument();
  });

  it("offers a retry from the failed-load state", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();

    renderSurface({
      state: { kind: "error", message: "ERR_CONNECTION_REFUSED" },
      address: "http://localhost:5173/",
      onReload,
    });

    expect(screen.queryByTestId("browser-viewport")).not.toBeInTheDocument();
    expect(screen.getByText(/ERR_CONNECTION_REFUSED/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("swaps a still of the page in for the viewport while an overlay is open", () => {
    renderSurface({ snapshot: "data:image/png;base64,SNAP" });

    const snapshot = screen.getByTestId("browser-snapshot");

    // Same rect as the placeholder the native view was painting into, so the
    // swap does not shift anything on screen.
    expect(snapshot).toHaveAttribute("src", "data:image/png;base64,SNAP");
    expect(screen.getByTestId("browser-viewport")).toContainElement(snapshot);
  });

  it("turns design mode on from the toolbar", async () => {
    const user = userEvent.setup();
    const onDesignModeChange = vi.fn();

    renderSurface({ onDesignModeChange });

    await user.click(screen.getByRole("button", { name: "Design" }));

    expect(onDesignModeChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("reports how many elements are marked and clears them only when there are", async () => {
    const user = userEvent.setup();
    const props = surfaceProps();
    const view = render(<ComposedBrowserSurface {...props} />);

    expect(
      screen.queryByTestId("browser-annotation-count"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear marks" })).toBeDisabled();

    view.rerender(<ComposedBrowserSurface {...props} annotationCount={2} isDesignMode />);

    expect(screen.getByTestId("browser-annotation-count")).toHaveTextContent(
      "2",
    );
    await user.click(screen.getByRole("button", { name: "Clear marks" }));

    expect(props.onClearAnnotations).toHaveBeenCalledTimes(1);
  });

  it("sends the marks to the composer, but only once there are some", async () => {
    const user = userEvent.setup();
    const props = surfaceProps();
    const view = render(<ComposedBrowserSurface {...props} />);
    const send = () => screen.getByRole("button", { name: "Send to composer" });

    // An unmarked page has nothing to say: the prompt would be a URL and a
    // screenshot with no question attached to it.
    expect(send()).toBeDisabled();

    view.rerender(<ComposedBrowserSurface {...props} annotationCount={1} />);
    await user.click(send());

    expect(props.onSendToComposer).toHaveBeenCalledTimes(1);
  });

  it("keeps the design controls out of reach until a page is live", () => {
    renderSurface({
      state: { kind: "blank" },
      annotationCount: 2,
      isDesignMode: true,
    });

    const design = screen.getByRole("button", { name: "Design" });

    expect(design).toBeDisabled();
    // Nothing is marked where there is no page, so a pressed-but-disabled
    // toggle and a leftover count would both be lying.
    expect(design).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.queryByTestId("browser-annotation-count"),
    ).not.toBeInTheDocument();
  });

  it("only offers Open in browser once there is a page to open", () => {
    renderSurface({ state: { kind: "blank" } });
    expect(
      screen.getByRole("button", { name: "Open in default browser" }),
    ).toBeDisabled();

    screen.getByRole("textbox", { name: "Address" });
  });

  it("renders the native viewport placeholder only while live", () => {
    const { rerender } = render(
      <BrowserSurface state={{ kind: "empty" }}>
        <BrowserSurface.Viewport />
      </BrowserSurface>,
    );

    expect(screen.queryByTestId("browser-viewport")).not.toBeInTheDocument();

    rerender(
      <BrowserSurface state={{ kind: "live" }}>
        <BrowserSurface.Viewport />
      </BrowserSurface>,
    );

    expect(screen.getByTestId("browser-viewport")).toBeInTheDocument();
  });

  it("takes initializing and opening from empty state instead of booleans", () => {
    const onAddTab = vi.fn();
    const { rerender } = render(
      <BrowserSurface state={{ kind: "empty", phase: "initializing" }}>
        <BrowserSurface.Viewport onAddTab={onAddTab} />
      </BrowserSurface>,
    );

    expect(screen.getByText("Loading browser…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open browser" })).not.toBeInTheDocument();

    rerender(
      <BrowserSurface state={{ kind: "empty", phase: "opening" }}>
        <BrowserSurface.Viewport onAddTab={onAddTab} />
      </BrowserSurface>,
    );

    expect(screen.getByRole("button", { name: "Open browser" })).toBeDisabled();
  });
});

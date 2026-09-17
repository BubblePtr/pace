import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserAnnotationCapture,
  BrowserEvent,
  BrowserTabTarget,
} from "@/shared/browser-protocol";
import type { PaceRendererApi } from "@/shared/runtime";
import {
  subscribeComposerInjections,
  type ComposerInjection,
} from "@/entities/session/composer-injections";
import { createBrowserHost } from "../../electron/browser-host";
import { SessionDockMotionContext } from "@/shared/ui/session-dock/session-dock";
import { SessionBrowserPanel } from "./session-browser-panel";

const marks = [
  {
    index: 1,
    selector: "#cta",
    tag: "button",
    rect: { x: 0, y: 0, width: 8, height: 8 },
  },
];
const viewport = { width: 900, height: 820, dpr: 2 };
const settledCapture: BrowserAnnotationCapture = {
  image: "data:image/png;base64,SNAP",
  url: "http://localhost:3000/",
  viewport,
  annotations: [{ ...marks[0]!, comment: "Too small to hit" }],
};

function installPreload(
  options: {
    captureGate?: Promise<void>;
    activateGate?: Promise<void>;
    annotationGate?: Promise<void>;
    failCapture?: boolean;
    openGate?: Promise<void>;
    failOpen?: boolean;
  } = {},
) {
  const invocations: Array<{
    command: string;
    args?: Record<string, unknown>;
  }> = [];
  const listeners = new Set<(event: BrowserEvent) => void>();
  const host = createBrowserHost({
    createView() {
      let url = "";
      return {
        setBounds() {},
        setVisible() {},
        async loadUrl(next) {
          url = next;
        },
        goBack() {},
        goForward() {},
        setDesignMode() {},
        clearAnnotations() {},
        prepareCapture() {},
        reload() {},
        destroy() {},
        readState: () => ({ url, canGoBack: false, canGoForward: false }),
        capture: async () => "data:image/png;base64,SNAP",
      };
    },
    getContentSize: () => ({ width: 1440, height: 900 }),
    openExternal() {},
    emit(event) {
      listeners.forEach((listener) => listener(event));
    },
  });
  window.pace = {
    invoke: (async (command, args) => {
      invocations.push({ command, args });
      if (command === "browser_open") {
        await options.openGate;
        if (options.failOpen) throw new Error("Browser could not start");
      }
      if (command === "browser_capture") {
        await options.captureGate;
        return "data:image/png;base64,SNAP";
      }
      if (command === "browser_capture_annotation") {
        await options.annotationGate;
        if (options.failCapture) throw new Error("Cannot capture");
        return settledCapture;
      }
      const answer = await host.invoke(command, args);
      if (command === "browser_activate") await options.activateGate;
      return answer;
    }) as PaceRendererApi["invoke"],
    onBackendEvent: () => () => {},
    onWindowFocusChanged: () => () => {},
    onNavigateRequest: () => () => {},
    onUpdateEvent: () => () => {},
    onBrowserEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    host,
    invocations,
    async target(index = 0, sessionId = "s") {
      const group = (await host.invoke("browser_list", {
        sessionId,
      })) as import("@/shared/browser-protocol").BrowserSessionState;
      return group.tabs[index]!;
    },
    mark(target: BrowserTabTarget) {
      act(() => {
        host.tab(target).recordAnnotations(marks, viewport);
        host.notify(target);
      });
    },
  };
}
function mount() {
  return render(<SessionBrowserPanel docked projectId="p" sessionId="s" />);
}
/**
 * Opens the browser if it is not already, and — since opening never restores
 * a URL (#224) — types the default preview address when the resulting tab is
 * still blank. A reattached Session whose native tab already has a URL
 * (e.g. a second mount of the same Session) is left alone.
 */
async function restored() {
  await waitFor(() => expect(screen.queryByText("Loading browser…")).not.toBeInTheDocument());
  const open = screen.queryByRole("button", { name: "Open browser" });
  if (open) await userEvent.click(open);
  const address = (await screen.findByRole("textbox", {
    name: "Address",
  })) as HTMLInputElement;
  if (!address.value) await userEvent.type(address, "localhost:3000{Enter}");
  await screen.findByDisplayValue("http://localhost:3000/");
}

describe("SessionBrowserPanel multi-instance", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    delete window.pace;
    vi.restoreAllMocks();
  });

  it("starts blank and ignores any previously persisted tab group", async () => {
    // Simulate leftover data from the old localStorage-restore feature
    // (#224): opening the Browser must never read it.
    window.localStorage.setItem(
      "pigui.browserTabs.v1",
      JSON.stringify({
        p: { tabs: ["http://localhost:3000/", "http://localhost:4000/"], activeIndex: 1 },
      }),
    );
    const preload = installPreload();
    const user = userEvent.setup();
    mount();
    await screen.findByText("No browser tabs open");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "Address" })).not.toBeInTheDocument();
    expect(await preload.target()).toBeUndefined();
    expect(preload.invocations).toEqual([{ command: "browser_attach", args: { sessionId: "s" } }]);

    await user.click(screen.getByRole("button", { name: "Open browser" }));
    expect(preload.invocations).toContainEqual({
      command: "browser_open",
      args: { sessionId: "s" },
    });
  });

  it("opens a new tab in the blank state, with no URL, until one is typed", async () => {
    installPreload();
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Open browser" }));
    expect(await screen.findByText("No page loaded")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("");
    await user.type(
      screen.getByRole("textbox", { name: "Address" }),
      "localhost:3000{Enter}",
    );
    await screen.findByDisplayValue("http://localhost:3000/");
    expect(screen.queryByText("No page loaded")).not.toBeInTheDocument();
  });

  it("prevents duplicate creates while pending and allows retry after failure", async () => {
    let release = () => {};
    const options = {
      openGate: new Promise<void>((resolve) => { release = resolve; }),
      failOpen: true,
    };
    const preload = installPreload(options);
    const user = userEvent.setup();
    mount();
    const open = await screen.findByRole("button", { name: "Open browser" });
    await user.click(open);
    expect(open).toBeDisabled();
    await user.click(open);
    expect(preload.invocations.filter((item) => item.command === "browser_open")).toHaveLength(1);
    await act(async () => release());
    expect(await screen.findByText("Browser could not start")).toBeInTheDocument();
    expect(open).toBeEnabled();
    options.failOpen = false;
    await user.click(open);
    expect(await screen.findByRole("tab", { name: "Browser 1" })).toBeInTheDocument();
    expect(screen.queryByText("Browser could not start")).not.toBeInTheDocument();
  });

  it("opens two pages, switches their drafts independently, reports counts and closes to empty", async () => {
    const user = userEvent.setup();
    const preload = installPreload();
    const count = vi.fn();
    render(
      <SessionBrowserPanel
        docked
        projectId="p"
        sessionId="s"
        onInstancesChange={count}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Open browser" }));
    await user.type(
      screen.getByRole("textbox", { name: "Address" }),
      "localhost:3000{Enter}",
    );
    await restored();
    await user.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("");
    await user.type(
      screen.getByRole("textbox", { name: "Address" }),
      "localhost:4000{Enter}",
    );
    await screen.findByDisplayValue("http://localhost:4000/");
    await user.clear(screen.getByRole("textbox", { name: "Address" }));
    await user.type(
      screen.getByRole("textbox", { name: "Address" }),
      "draft.local",
    );
    await user.click(screen.getByRole("tab", { name: "Browser 1" }));
    await restored();
    await user.click(screen.getByRole("tab", { name: "Browser 2" }));
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue(
      "draft.local",
    );
    expect(count).toHaveBeenLastCalledWith(expect.any(Array));
    expect(count.mock.lastCall?.[0]).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Close Browser 2" }));
    await user.click(screen.getByRole("button", { name: "Close Browser 1" }));
    expect(screen.getByText("No browser tabs open")).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(preload.invocations.filter((item) => item.command === "browser_open")).toHaveLength(2);
    expect(count.mock.lastCall?.[0]).toHaveLength(0);
  });

  it("keeps background failure and design marks attached to their tab", async () => {
    const user = userEvent.setup();
    const preload = installPreload();
    mount();
    await restored();
    const first = await preload.target();
    act(() => {
      preload.host.tab(first).recordPageState({ loading: true });
      preload.host.notify(first);
    });
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Design" }));
    preload.mark(first);
    await user.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(screen.queryByTestId("browser-annotation-count")).toBeNull();
    act(() => {
      preload.host.tab(first).recordLoadFailure("OFFLINE");
      preload.host.notify(first);
    });
    expect(screen.queryByText("OFFLINE")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Browser 1" }));
    expect(await screen.findByText("OFFLINE")).toBeInTheDocument();
    act(() => {
      preload.host.tab(first).recordPageState({ navigated: true });
      preload.host.notify(first);
    });
    expect(
      await screen.findByTestId("browser-annotation-count"),
    ).toHaveTextContent("1 marked");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    act(() => {
      preload.host.tab(first).recordDesignMode(false);
      preload.host.notify(first);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
  });

  it("does not overwrite newer marks with a delayed activation snapshot", async () => {
    let release = () => {};
    const preload = installPreload({
      activateGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const user = userEvent.setup();
    mount();
    await restored();
    const first = await preload.target();
    await user.click(screen.getByRole("button", { name: "New browser tab" }));
    await user.click(screen.getByRole("tab", { name: "Browser 1" }));
    preload.mark(first);
    await act(async () => release());
    expect(
      await screen.findByTestId("browser-annotation-count"),
    ).toHaveTextContent("1 marked");
  });

  it("hides on unmount, preserves marks on reattach, and never commands from a narrow Sheet", async () => {
    const preload = installPreload();
    const view = mount();
    await restored();
    preload.mark(await preload.target());
    view.unmount();
    expect(preload.invocations).toContainEqual({
      command: "browser_hide_session",
      args: { sessionId: "s" },
    });
    const next = mount();
    await restored();
    expect(
      await screen.findByTestId("browser-annotation-count"),
    ).toHaveTextContent("1 marked");
    next.unmount();
    preload.invocations.length = 0;
    const narrow = render(
      <SessionBrowserPanel docked={false} projectId="p" sessionId="s" />,
    );
    expect(screen.getByText(/widen the window/i)).toBeInTheDocument();
    narrow.unmount();
    expect(preload.invocations).toHaveLength(0);
  });

  it("ignores events and late navigation completions from the previous Session", async () => {
    const preload = installPreload();
    const view = mount();
    await restored();
    const first = await preload.target();
    view.rerender(
      <SessionBrowserPanel docked projectId="q" sessionId="next" />,
    );
    await screen.findByText("No browser tabs open");
    act(() => {
      preload.host.tab(first).recordLoadFailure("OLD ERROR");
      preload.host.notify(first);
    });
    expect(screen.queryByText("OLD ERROR")).toBeNull();
  });

  it("sends only the active tab's settled capture once, using the loaded URL", async () => {
    let release = () => {};
    const preload = installPreload({
      annotationGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const user = userEvent.setup();
    const injections: ComposerInjection[] = [];
    const unsubscribe = subscribeComposerInjections("s", (injection) =>
      injections.push(injection),
    );
    mount();
    await restored();
    const first = await preload.target();
    preload.mark(first);
    await user.clear(screen.getByRole("textbox", { name: "Address" }));
    await user.type(
      screen.getByRole("textbox", { name: "Address" }),
      "draft.local",
    );
    const send = screen.getByRole("button", { name: "Send to composer" });
    await user.click(send);
    expect(send).toBeDisabled();
    await user.click(send);
    await act(async () => release());
    await waitFor(() => expect(injections).toHaveLength(1));
    expect(
      preload.invocations.filter(
        (i) => i.command === "browser_capture_annotation",
      ),
    ).toEqual([
      {
        command: "browser_capture_annotation",
        args: { sessionId: "s", tabId: first.tabId },
      },
    ]);
    expect(injections[0]?.text).toContain("Too small to hit");
    expect(injections[0]?.text).toContain("http://localhost:3000/");
    expect(injections[0]?.files?.[0]).toBeInstanceOf(File);
    unsubscribe();
  });

  it.each(["tab", "session", "close"])(
    "discards an in-flight send after a %s switch",
    async (change) => {
      let release = () => {};
      const preload = installPreload({
        annotationGate: new Promise<void>((resolve) => {
          release = resolve;
        }),
      });
      const user = userEvent.setup();
      const injections: ComposerInjection[] = [];
      const unsubscribe = subscribeComposerInjections("s", (injection) =>
        injections.push(injection),
      );
      const view = mount();
      await restored();
      preload.mark(await preload.target());
      await user.click(
        screen.getByRole("button", { name: "Send to composer" }),
      );
      if (change === "session")
        view.rerender(
          <SessionBrowserPanel docked projectId="q" sessionId="next" />,
        );
      else
        await user.click(
          screen.getByRole("button", {
            name: change === "tab" ? "New browser tab" : "Close Browser 1",
          }),
        );
      await act(async () => release());
      expect(injections).toHaveLength(0);
      unsubscribe();
    },
  );

  it("falls back to text on capture failure and reports when no composer is mounted", async () => {
    const user = userEvent.setup();
    const preload = installPreload({ failCapture: true });
    mount();
    await restored();
    preload.mark(await preload.target());
    await user.click(screen.getByRole("button", { name: "Send to composer" }));
    expect(
      await screen.findByTestId("browser-surface-notice"),
    ).toHaveTextContent(/No composer/);
    const injections: ComposerInjection[] = [];
    const unsubscribe = subscribeComposerInjections("s", (injection) =>
      injections.push(injection),
    );
    await user.click(screen.getByRole("button", { name: "Send to composer" }));
    await waitFor(() => expect(injections).toHaveLength(1));
    expect(injections[0]?.files).toEqual([]);
    expect(injections[0]?.text).toContain("no screenshot could be taken");
    unsubscribe();
  });

  it("hides the native view behind a still while the dock moves, and reuses that still on the next mount", async () => {
    const preload = installPreload();
    const panel = (moving: boolean) => (
      <SessionDockMotionContext.Provider value={moving}>
        <SessionBrowserPanel docked projectId="p" sessionId="s" />
      </SessionDockMotionContext.Provider>
    );
    const visibleCalls = (): unknown[] =>
      preload.invocations
        .filter((i) => i.command === "browser_set_visible")
        .map((i) => i.args?.visible);
    const { rerender, unmount } = render(panel(false));
    await restored();
    await waitFor(() => expect(visibleCalls()[visibleCalls().length - 1]).toBe(true));

    // Dock starts closing: grab a still of the visible page, then step aside.
    rerender(panel(true));
    await waitFor(() => expect(visibleCalls()[visibleCalls().length - 1]).toBe(false));
    await waitFor(() =>
      expect(preload.invocations.some((i) => i.command === "browser_capture")).toBe(true),
    );
    expect(await screen.findByTestId("browser-snapshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,SNAP",
    );

    // Settled: the still goes away and the native view is back.
    rerender(panel(false));
    await waitFor(() => expect(screen.queryByTestId("browser-snapshot")).toBeNull());
    await waitFor(() => expect(visibleCalls()[visibleCalls().length - 1]).toBe(true));

    // Reopening plays the enter with the cached still instead of a capture of
    // a view that is still hidden.
    unmount();
    preload.invocations.length = 0;
    render(panel(true));
    await restored();
    expect(await screen.findByTestId("browser-snapshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,SNAP",
    );
    expect(preload.invocations.some((i) => i.command === "browser_capture")).toBe(false);
    expect(visibleCalls()).not.toContain(true);
  });

  it("drops a delayed overlay still when the active tab changes", async () => {
    let release = () => {};
    const preload = installPreload({
      captureGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const user = userEvent.setup();
    render(
      <>
        <SessionBrowserPanel docked projectId="p" sessionId="s" />
        <Tooltip content="Rail hint" delay={0}>
          <IconButton icon={<span>i</span>} label="Rail" />
        </Tooltip>
      </>,
    );
    await restored();
    await user.hover(screen.getByRole("button", { name: "Rail" }));
    await waitFor(() =>
      expect(
        preload.invocations.some((i) => i.command === "browser_capture"),
      ).toBe(true),
    );
    await user.unhover(screen.getByRole("button", { name: "Rail" }));
    await user.click(screen.getByRole("button", { name: "New browser tab" }));
    await act(async () => release());
    expect(screen.queryByTestId("browser-snapshot")).toBeNull();
  });
});

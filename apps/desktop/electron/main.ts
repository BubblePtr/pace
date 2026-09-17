import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  session,
  shell,
  WebContentsView,
  type MessagePortMain,
  utilityProcess,
} from "electron";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoUpdater } from "electron-updater";
import type { BackendRpcEvent, BackendRpcResponse } from "@pace/backend";
import { browserEventChannel, type BrowserEvent, type BrowserTabTarget } from "@/shared/browser-protocol";
import { updateEventChannel } from "@/shared/update-protocol";
import {
  acceptBrowserAnnotationMessage,
  browserAnnotationChannel,
  browserAnnotationCommandChannel,
  type BrowserAnnotationCommand,
} from "./browser-annotation";
import {
  resolveBackendEnvironment,
  resolveUserDataPath,
} from "./backend-environment";
import {
  createBrowserHost,
  createBrowserSessionProvider,
  isAbortedLoadError,
  isBrowserCommand,
  type BrowserHost,
} from "./browser-host";
import { downsampleToCssWidth } from "./capture-downsample";
import { isTrustedInvokeSender } from "./ipc-sender-guard";
import { installAppMenu } from "./app-menu";
import { navigateAppWindow } from "./app-navigation";
import { createAppUpdater, type AppUpdater, type AutoUpdaterLike } from "./updater";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
let appUpdater: AppUpdater | null = null;
/**
 * Bind trusted webContents to their tab; embedded pages cannot choose identity.
 */
const browserAnnotationSenders = new Map<Electron.WebContents, BrowserTabTarget>();
let backendPort: MessagePortMain | null = null;
let backendProcess: ReturnType<typeof utilityProcess.fork> | null = null;
let backendRestartTimer: ReturnType<typeof setTimeout> | null = null;
let backendRequestCounter = 0;
let backendGeneration = 0;
let backendRestartAttempt = 0;
let appQuitting = false;
const pendingRequests = new Map<string, PendingRequest>();
const backendRestartBaseDelayMs = 250;
const backendRestartMaxDelayMs = 5_000;
const e2eKillBackendCommand = "__e2e_kill_backend";

function rendererUrl() {
  return process.env.ELECTRON_RENDERER_URL;
}

function preloadPath() {
  return join(__dirname, "../preload/preload.js");
}

/**
 * The annotation layer, and the only script the embedded page ever gets. It is
 * a separate bundle from the renderer preload on purpose — see that file.
 */
function browserAnnotationPreloadPath() {
  return join(__dirname, "../preload/browser-annotation-preload.js");
}

function backendPath() {
  return join(__dirname, "backend.js");
}

/**
 * Packaged apps use Resources/icon.icns via Info.plist.
 * Dev (`electron-vite` / `bun run dev`) launches Electron.app itself, so Dock
 * stays on the default atom unless we set it explicitly.
 *
 * Repo layout in dev: apps/desktop/out/main → ../../../../build/icon-512.png
 */
function applyDevelopmentDockIcon() {
  if (process.platform !== "darwin" || !app.dock) {
    return;
  }

  // Only override when running under the Vite/Electron dev server.
  if (!process.env.ELECTRON_RENDERER_URL) {
    return;
  }

  const candidates = [
    join(__dirname, "../../../../build/icon-512.png"),
    join(__dirname, "../../../../build/icon.icns"),
  ];

  for (const iconPath of candidates) {
    if (!existsSync(iconPath)) {
      continue;
    }

    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      continue;
    }

    app.dock.setIcon(image);
    return;
  }
}

// E2E launches one Electron per test; a normal show() would activate the app
// and steal the developer's focus every time. Keep those windows in the
// background: no Dock presence, shown without activation.
const backgroundWindowForEndToEnd = process.env.PACE_E2E === "1";

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 720,
    show: !backgroundWindowForEndToEnd,
    // Headless macOS runners can expose displays smaller than the E2E viewport.
    enableLargerThanScreen: backgroundWindowForEndToEnd,
    title: "Pace",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 13 },
    ...(process.platform === "darwin"
      ? {
          // Transparent web contents are required for vibrancy to show through
          // CSS; `sidebar` material is too dense to read as glass.
          transparent: true,
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
        }
      : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  if (backgroundWindowForEndToEnd) {
    mainWindow.once("ready-to-show", () => {
      // Fully transparent: the window still renders for CDP screenshots but
      // never covers the developer's screen.
      mainWindow?.setOpacity(0);
      mainWindow?.showInactive();
    });
  }
  mainWindow.on("focus", () => {
    mainWindow?.webContents.send("pigui:window-focus");
  });
  mainWindow.webContents.on("did-start-navigation", (event) => {
    // Reload does not run React cleanup; native pages outlive the renderer.
    if (event.isMainFrame && !event.isSameDocument) {
      browserHost?.detachRenderer();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    browserHost?.dispose();
    browserHost = null;
  });

  if (rendererUrl()) {
    void mainWindow.loadURL(rendererUrl()!);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

function navigateToSettings() {
  navigateAppWindow(
    {
      getWindow: () => mainWindow,
      createWindow: createMainWindow,
    },
    // Settings is a dialog over the current route (#201); "." keeps the
    // workspace mounted and the search param opens the About panel.
    { to: ".", search: { settings: "about" } },
  );
}

function createBackendBridge() {
  backendGeneration += 1;
  const generation = backendGeneration;
  const backend = utilityProcess.fork(backendPath(), [], {
    env: resolveBackendEnvironment({
      env: { ...process.env, PI_PACKAGE_DIR: join(__dirname, "pi-assets") },
      isPackaged: app.isPackaged,
      homeDir: homedir(),
    }),
    stdio: "pipe",
  });
  const { port1, port2 } = new MessageChannelMain();

  backendProcess = backend;
  backendPort = port1;
  backend.postMessage({ type: "connect" }, [port2]);
  port1.on("message", ({ data }) => {
    if (generation !== backendGeneration) {
      return;
    }

    if (isBackendRpcEvent(data)) {
      mainWindow?.webContents.send("pigui:backend-event", data);
      return;
    }

    if (isBackendRpcResponse(data)) {
      backendRestartAttempt = 0;
      const pending = pendingRequests.get(data.id);
      if (!pending) {
        return;
      }

      pendingRequests.delete(data.id);
      if (data.error) {
        pending.reject(new Error(data.error));
      } else {
        pending.resolve(data.result);
      }
    }
  });
  port1.start();
  sendBackendLifecycleEvent({
    generation,
    lifecycle: "connected",
    title: "Backend connected",
    body: "Pace backend utility process is connected.",
  });
  backend.on("exit", (code) => {
    if (generation !== backendGeneration) {
      return;
    }

    const error = new Error(`Pace backend utility process exited with code ${code}.`);

    backendProcess = null;
    port1.close();
    backendPort = null;
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    sendBackendLifecycleEvent({
      generation,
      lifecycle: "disconnected",
      title: "Backend exited",
      body: error.message,
    });
    scheduleBackendRestart();
  });
}

function startBackendBridge() {
  try {
    createBackendBridge();
  } catch (error) {
    sendBackendLifecycleEvent({
      generation: backendGeneration,
      lifecycle: "disconnected",
      title: "Backend start failed",
      body: error instanceof Error ? error.message : String(error),
    });
    scheduleBackendRestart();
  }
}

function scheduleBackendRestart() {
  if (appQuitting || backendRestartTimer) {
    return;
  }

  const delay = Math.min(
    backendRestartBaseDelayMs * 2 ** backendRestartAttempt,
    backendRestartMaxDelayMs,
  );

  backendRestartAttempt += 1;
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null;
    startBackendBridge();
  }, delay);
}

function sendBackendLifecycleEvent(input: {
  generation: number;
  lifecycle: "connected" | "disconnected";
  title: string;
  body: string;
}) {
  const connected = input.lifecycle === "connected";

  mainWindow?.webContents.send("pigui:backend-event", {
    type: "event",
    event: {
      id: `backend-${input.lifecycle}-${input.generation}`,
      seq: 0,
      sessionId: "__backend__",
      piSessionId: "__backend__",
      type: connected ? "status" : "error",
      ts: new Date().toISOString(),
      payload: {
        kind: connected ? "status" : "error",
        lifecycle: input.lifecycle,
        generation: input.generation,
        title: input.title,
        body: input.body,
      },
    },
  } satisfies BackendRpcEvent);
}

function invokeBackend(command: string, args?: Record<string, unknown>) {
  if (!backendPort) {
    return Promise.reject(new Error("Pace backend utility process is not connected."));
  }

  backendRequestCounter += 1;
  const id = `renderer-${backendRequestCounter}`;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    backendPort!.postMessage({
      id,
      method: command,
      params: args,
    });
  });
}

async function selectProjectDirectory() {
  const owner = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = owner
    ? await dialog.showOpenDialog(owner, {
        title: "Select Project",
        properties: ["openDirectory"],
      })
    : await dialog.showOpenDialog({
        title: "Select Project",
        properties: ["openDirectory"],
      });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0] ?? null;
}

async function revealProjectInFinder(args?: Record<string, unknown>) {
  const path = typeof args?.path === "string" ? args.path : "";

  if (!path) {
    throw new Error("Project path is required.");
  }

  // Chats "Open folder" passes ensure so we mkdir only on that click, not
  // when Settings merely looks up the path.
  if (args?.ensure === true) {
    await mkdir(path, { recursive: true });
  }

  shell.showItemInFolder(path);
}

/**
 * Embedded browser surface. The view is a native child of the window, kept
 * out of the utilityProcess entirely, and its session is isolated from the
 * Pace renderer's so a dev site's cookies and storage never mix with ours.
 * `persist:` keeps a local dev login across restarts.
 */
const browserPartition = "persist:pigui-browser";
/**
 * Matches `--color-background-surface` (theme-neutral `light-dark`). The
 * native view is opaque, so on macOS it must paint the panel's own colour or
 * it punches a hole in the window vibrancy before the page's first paint.
 */
const browserViewBackground = { light: "#ffffff", dark: "#262626" };

function emitBrowserEvent(event: BrowserEvent) {
  mainWindow?.webContents.send(browserEventChannel, event);
}

const browserViewSession = createBrowserSessionProvider(
  () => {
    const electronSession = session.fromPartition(browserPartition);

    return {
      electronSession,
      setPermissionRequestHandler(allow: (permission: string) => boolean) {
        electronSession.setPermissionRequestHandler(
          (_contents, permission, callback) => callback(allow(permission)),
        );
      },
      setPermissionCheckHandler(allow: (permission: string) => boolean) {
        electronSession.setPermissionCheckHandler((_contents, permission) =>
          allow(permission),
        );
      },
      blockDownloads() {
        electronSession.on("will-download", (event) => {
          event.preventDefault();
        });
      },
    };
  },
  (permission) => getBrowserHost().allowsPermission(permission),
);

function createBrowserView(target: BrowserTabTarget) {
  const window = mainWindow;

  if (!window) {
    throw new Error("The Pace window is not open.");
  }

  const view = new WebContentsView({
    webPreferences: {
      session: browserViewSession().electronSession,
      preload: browserAnnotationPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const { webContents } = view;

  browserAnnotationSenders.set(webContents, target);
  view.setBackgroundColor(
    nativeTheme.shouldUseDarkColors
      ? browserViewBackground.dark
      : browserViewBackground.light,
  );
  view.setVisible(false);
  window.contentView.addChildView(view);

  // Page-initiated navigation, main frame and subframes. Two gaps to know
  // about: main-process loads never reach these hooks (so `browser_navigate`
  // checks the URL itself), and Chromium decides some navigations before
  // them — `file:` from an http page is refused upstream and never arrives,
  // `about:blank` commits without an event at all.
  webContents.on("will-navigate", (event, url) => {
    if (!getBrowserHost().allowsNavigationTo(url)) {
      event.preventDefault();
    }
  });
  webContents.on("will-frame-navigate", (event) => {
    if (!getBrowserHost().allowsNavigationTo(event.url)) {
      event.preventDefault();
    }
  });
  webContents.setWindowOpenHandler(({ url }) => {
    // Loading from inside the handler starts a navigation on the very contents
    // still waiting for this reply, and the page hangs. Answer the deny first,
    // then redirect the view on the next tick.
    setImmediate(() => {
      if (browserAnnotationSenders.has(webContents)) {
        getBrowserHost().tab(target).handleWindowOpen(url);
      }
    });
    return { action: "deny" };
  });

  const emitNavigation = () => {
    if (!browserAnnotationSenders.has(webContents)) return;
    getBrowserHost().tab(target).recordPageState({ navigated: true });
    getBrowserHost().notify(target);
  };
  webContents.on("page-title-updated", (_event, title) => {
    if (!browserAnnotationSenders.has(webContents)) return;
    getBrowserHost().tab(target).recordPageState({ title });
    getBrowserHost().notify(target);
  });
  webContents.on("did-start-loading", () => {
    if (!browserAnnotationSenders.has(webContents)) return;
    getBrowserHost().tab(target).recordPageState({ loading: true });
    getBrowserHost().notify(target);
  });
  webContents.on("did-stop-loading", () => {
    // Closing a tab can finish a pending load after its membership is removed.
    if (!browserAnnotationSenders.has(webContents)) return;
    getBrowserHost().tab(target).recordPageState({ loading: false });
    getBrowserHost().notify(target);
  });

  webContents.on("did-navigate", emitNavigation);
  webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (isMainFrame) {
      emitNavigation();
    }
  });
  webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 is ABORTED: a load the user or a redirect replaced, not a failure.
      if (!isMainFrame || errorCode === -3) {
        return;
      }

      // The view is now on Chromium's error page, committed under the URL that
      // failed; the host has to know or it would treat the next attempt at
      // that URL as "already showing".
      if (!browserAnnotationSenders.has(webContents)) return;
      getBrowserHost().tab(target).recordLoadFailure(errorDescription || `Load failed (${errorCode}).`);
      getBrowserHost().notify(target);
    },
  );

  return {
    setBounds: (bounds: Electron.Rectangle) => view.setBounds(bounds),
    setVisible: (visible: boolean) => view.setVisible(visible),
    loadUrl: (url: string) =>
      webContents.loadURL(url).then(
        () => undefined,
        (error: unknown) => {
          // A page that supersedes its own pending navigation (baidu.com does
          // it on load) rejects the original loadURL with ERR_ABORTED while
          // the replacement loads fine. `did-fail-load` already ignores the
          // same code; the promise has to agree or the surface shows an error
          // over a page that is on screen and working.
          if (!isAbortedLoadError(error)) {
            throw error;
          }
        },
      ),
    goBack: () => webContents.navigationHistory.goBack(),
    goForward: () => webContents.navigationHistory.goForward(),
    setDesignMode: (enabled: boolean) =>
      sendAnnotationCommand(webContents, { type: "set-design-mode", enabled }),
    clearAnnotations: () =>
      sendAnnotationCommand(webContents, { type: "clear-annotations" }),
    prepareCapture: () =>
      sendAnnotationCommand(webContents, { type: "prepare-capture" }),
    reload: () => webContents.reload(),
    destroy: () => {
      browserAnnotationSenders.delete(webContents);
      // Disposal also runs after the window is gone (quit). Tearing the
      // contents down is the part that matters — leave it alive and the app
      // never exits — and touching a destroyed window throws, so order and
      // guard both.
      if (!webContents.isDestroyed()) {
        webContents.close();
      }
      if (!window.isDestroyed()) {
        window.contentView.removeChildView(view);
      }
    },
    readState: () => ({
      url: webContents.getURL(),
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward(),
    }),
    async capture(maxWidth?: number) {
      // Whole view, so the still lines up with the placeholder rect exactly.
      const image = await webContents.capturePage();

      if (image.isEmpty()) {
        return null;
      }

      // Resizing by width alone keeps the aspect ratio; who asks for a cap,
      // and why, is `browser_capture_annotation` in browser-host.ts. The
      // downsample itself lives in capture-downsample.ts so it can be unit
      // tested at both 1x and 2x scale without a real HiDPI display.
      return downsampleToCssWidth(image, maxWidth).toDataURL();
    },
  };
}

function sendAnnotationCommand(
  contents: Electron.WebContents,
  command: BrowserAnnotationCommand,
) {
  if (!contents.isDestroyed()) {
    contents.send(browserAnnotationCommandChannel, command);
  }
}

/**
 * The embedded page's one way in. Everything it says is checked twice: the
 * sender must be this window's own view (`pigui:invoke` now also checks its
 * sender, but annotations still get their own channel rather than sharing
 * one), and the message must be one of the three shapes the protocol knows.
 */
ipcMain.on(browserAnnotationChannel, (event, payload: unknown) => {
  const target = browserAnnotationSenders.get(event.sender);
  if (!target) return;
  const message = acceptBrowserAnnotationMessage({
    sender: event.sender,
    trustedSender: event.sender,
    message: payload,
  });

  if (!message) {
    return;
  }

  const host = getBrowserHost().tab(target);

  switch (message.type) {
    case "ready":
      // A new document carries a new overlay: no marks on it, and design mode
      // has to be put back if the user never left it.
      sendAnnotationCommand(event.sender, {
        type: "set-design-mode",
        enabled: host.isDesignModeEnabled(),
      });
      host.recordAnnotations([], null);
      getBrowserHost().notify(target);
      break;
    case "annotations":
      // Kept on the host as well as forwarded: a capture whose prepare goes
      // unanswered falls back to the last marks that arrived here.
      host.recordAnnotations(message.annotations, message.viewport);
      getBrowserHost().notify(target);
      break;
    case "capture-ready":
      // The answer to a prepare — it releases the capture waiting on it. The
      // renderer hears about these marks in the capture's own result, not as
      // an event, so the two cannot disagree.
      host.recordCaptureReady(message.annotations, message.viewport);
      break;
    case "design-mode":
      host.recordDesignMode(message.enabled);
      getBrowserHost().notify(target);
      break;
  }
});

function getBrowserHost() {
  browserHost ??= createBrowserHost({
    createView: createBrowserView,
    emit: emitBrowserEvent,
    getContentSize() {
      const size = mainWindow?.getContentBounds();

      return size ? { width: size.width, height: size.height } : null;
    },
    openExternal: (url) => shell.openExternal(url),
  });

  return browserHost;
}

function killBackendForEndToEndTest() {
  if (process.env.PACE_E2E !== "1") {
    throw new Error("The Pace E2E backend control is disabled.");
  }

  if (!backendProcess) {
    throw new Error("Pace backend utility process is not running.");
  }

  const generation = backendGeneration;

  backendProcess.kill();

  return { generation };
}

ipcMain.handle(
  "pigui:invoke",
  (event, input: { command: string; args?: Record<string, unknown> }) => {
    // Only the app's own main window may drive commands (dialogs, backend
    // RPC, browser control) through this channel — an embedded
    // `WebContentsView` browser tab, or anything else, is rejected outright.
    if (
      !isTrustedInvokeSender({
        sender: event.sender,
        mainWebContents: mainWindow?.webContents ?? null,
      })
    ) {
      throw new Error("pigui:invoke rejected: sender is not the main window.");
    }

    if (input.command === e2eKillBackendCommand) {
      return killBackendForEndToEndTest();
    }

    if (input.command === "select_local_resource") {
      return dialog.showOpenDialog({ title: "Add local resource", properties: ["openFile", "openDirectory"], filters: [{ name: "Pi resources", extensions: ["ts", "js", "md", "json"] }] })
        .then(result => result.canceled ? null : result.filePaths[0] ?? null);
    }

    if (input.command === "select_project_directory") {
      return selectProjectDirectory();
    }

    if (input.command === "reveal_project_in_finder") {
      return revealProjectInFinder(input.args);
    }

    if (input.command === "update:status") {
      return appUpdater?.getStatus();
    }

    if (input.command === "update:check") {
      return appUpdater?.check();
    }

    if (input.command === "update:install") {
      return appUpdater?.install();
    }

    if (isBrowserCommand(input.command)) {
      return getBrowserHost().invoke(input.command, input.args);
    }

    return invokeBackend(input.command, input.args);
  },
);

// Must run before any session/profile access, so it sits ahead of whenReady.
app.setName("Pace");
const userDataPath = resolveUserDataPath({
  appDataPath: app.getPath("appData"),
  isPackaged: app.isPackaged,
  // getPath("userData") can create the destination and prevent legacy migration.
  ...(app.commandLine.hasSwitch("user-data-dir")
    ? { hasUserDataDirSwitch: true, userDataPath: app.getPath("userData") }
    : { hasUserDataDirSwitch: false }),
});
app.setPath("userData", userDataPath);

app.whenReady().then(() => {
  if (backgroundWindowForEndToEnd && process.platform === "darwin") {
    app.dock?.hide();
  }
  applyDevelopmentDockIcon();
  startBackendBridge();
  appUpdater = createAppUpdater({
    // electron-updater's typed `on` only accepts its event map; the updater
    // seam takes a stringly EventEmitter-shaped client so tests can inject one.
    autoUpdater: autoUpdater as AutoUpdaterLike,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    // Packaged E2E is still isPackaged; without this it would hit GitHub after 10s.
    disabledReason:
      process.env.PACE_E2E === "1"
        ? "Updates are disabled during end-to-end tests."
        : undefined,
  });
  appUpdater.subscribe((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(updateEventChannel, status);
    }
  });
  installAppMenu({
    updater: appUpdater,
    menu: Menu,
    navigateToSettings,
  });
  createMainWindow();
  appUpdater.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let backendShutdownComplete = false;
app.on("before-quit", (event) => {
  appQuitting = true;
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  if (backendShutdownComplete || !backendProcess) return;
  event.preventDefault();
  if (backendShuttingDown) return;
  backendShuttingDown = true;
  void shutdownBackend().finally(() => {
    backendShutdownComplete = true;
    backendPort?.close();
    backendPort = null;
    backendProcess?.kill();
    backendProcess = null;
    app.quit();
  });
});

let backendShuttingDown = false;
function shutdownBackend(): Promise<void> {
  const backend = backendProcess;
  if (!backend) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      backend.off("message", onMessage);
      backend.off("exit", finish);
      resolve();
    };
    const onMessage = (message: { type?: string; error?: string }) => {
      if (message.type !== "shutdown_complete") return;
      if (message.error) console.error("Backend shutdown:", message.error);
      finish();
    };
    // A crashed or non-cooperative extension must not prevent app exit.
    const timer = setTimeout(() => {
      console.error("Backend shutdown timed out; interrupting remaining work.");
      finish();
    }, 30_000);
    backend.on("message", onMessage);
    backend.once("exit", finish);
    backend.postMessage({ type: "shutdown" });
  });
}

function isBackendRpcEvent(value: unknown): value is BackendRpcEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "event"
  );
}

function isBackendRpcResponse(value: unknown): value is BackendRpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    ("result" in value || "error" in value)
  );
}

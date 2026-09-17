import { ipcRenderer } from "electron";
import {
  browserAnnotationChannel,
  browserAnnotationCommandChannel,
  type BrowserAnnotationCommand,
} from "./browser-annotation";
import { createAnnotationOverlay } from "./browser-annotation-overlay";

/**
 * Preload for the embedded browser's `WebContentsView` — and nothing else.
 *
 * A preload already runs in an isolated world, so the overlay it builds is
 * invisible to page script without any bridging. That is the whole design:
 * **nothing is exposed to the page**. There is no `contextBridge` call here,
 * because a hostile page with a handle on any Pace API is exactly what the
 * annotation layer must not create. Traffic goes one way, over a channel of
 * its own that main re-validates on arrival (PRD S2 constraint 2) — never over
 * `pigui:invoke`, which is scoped to the main window's own sender and speaks
 * a different, command-shaped protocol.
 *
 * It also shares no module with `preload.ts`: electron-vite would hoist a
 * common import into a chunk, and a sandboxed preload cannot require one
 * (PRD S2 constraint 6). The build output has to stay two self-contained files.
 */

const overlay = createAnnotationOverlay({
  document,
  onAnnotationsChange(annotations, viewport) {
    ipcRenderer.send(browserAnnotationChannel, {
      type: "annotations",
      annotations,
      viewport,
    });
  },
  onDesignModeChange(enabled) {
    ipcRenderer.send(browserAnnotationChannel, { type: "design-mode", enabled });
  },
  onCaptureReady(annotations, viewport) {
    ipcRenderer.send(browserAnnotationChannel, {
      type: "capture-ready",
      annotations,
      viewport,
    });
  },
});

ipcRenderer.on(
  browserAnnotationCommandChannel,
  (_event, command: BrowserAnnotationCommand) => {
    switch (command?.type) {
      case "set-design-mode":
        overlay.setDesignMode(command.enabled === true);
        break;
      case "clear-annotations":
        overlay.clearAnnotations();
        break;
      case "prepare-capture":
        overlay.prepareCapture();
        break;
    }
  },
);

// Every navigation builds a new document with a new overlay. Announcing it is
// what lets main put design mode back and tell the renderer the marks are gone.
ipcRenderer.send(browserAnnotationChannel, { type: "ready" });

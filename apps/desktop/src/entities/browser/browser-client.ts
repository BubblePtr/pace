import { invoke, onBrowserEvent } from "@/shared/runtime";
import type {
  BrowserAnnotationCapture,
  BrowserEvent,
  BrowserSessionState,
  BrowserTabState,
  BrowserTabTarget,
  BrowserViewRect,
} from "@/shared/browser-protocol";

/**
 * Native views belong to main; every page command names its Session and tab.
 * Reattaches whatever native tabs main already has for this Session — it
 * never restores a previously saved tab group (#224).
 */
export function attachBrowserSession(sessionId: string) {
  return invoke<BrowserSessionState>("browser_attach", { sessionId });
}
export function openBrowserTab(sessionId: string) {
  return invoke<BrowserSessionState>("browser_open", { sessionId });
}
export function closeBrowserTab(target: BrowserTabTarget) {
  return invoke<BrowserSessionState>("browser_close", target);
}
export function activateBrowserTab(target: BrowserTabTarget) {
  return invoke<BrowserSessionState>("browser_activate", target);
}
export function hideBrowserSession(sessionId: string) {
  return invoke<null>("browser_hide_session", { sessionId });
}
export function navigateBrowser(target: BrowserTabTarget, url: string) {
  return invoke<BrowserTabState>("browser_navigate", { ...target, url });
}
export function browserBack(target: BrowserTabTarget) {
  return invoke<BrowserTabState | null>("browser_back", target);
}
export function browserForward(target: BrowserTabTarget) {
  return invoke<BrowserTabState | null>("browser_forward", target);
}
export function reloadBrowser(target: BrowserTabTarget) {
  return invoke<BrowserTabState | null>("browser_reload", target);
}
export function setBrowserBounds(
  target: BrowserTabTarget,
  rect: BrowserViewRect,
) {
  return invoke<BrowserTabState | null>("browser_set_bounds", {
    ...target,
    rect,
  });
}
export function setBrowserVisible(target: BrowserTabTarget, visible: boolean) {
  return invoke<BrowserTabState | null>("browser_set_visible", {
    ...target,
    visible,
  });
}
export function setBrowserDesignMode(
  target: BrowserTabTarget,
  enabled: boolean,
) {
  return invoke<BrowserTabState | null>("browser_set_design_mode", {
    ...target,
    enabled,
  });
}
export function clearBrowserAnnotations(target: BrowserTabTarget) {
  return invoke<BrowserTabState | null>("browser_clear_annotations", target);
}
export function captureBrowser(target: BrowserTabTarget) {
  return invoke<string | null>("browser_capture", target);
}
export function captureBrowserAnnotation(target: BrowserTabTarget) {
  return invoke<BrowserAnnotationCapture | null>(
    "browser_capture_annotation",
    target,
  );
}
export function openBrowserUrlExternally(url: string) {
  return invoke<null>("browser_open_external", { url });
}
export function subscribeBrowserEvents(
  listener: (event: BrowserEvent) => void,
) {
  return onBrowserEvent(listener);
}

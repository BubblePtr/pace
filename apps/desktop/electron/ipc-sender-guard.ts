/**
 * `pigui:invoke` is the embedded page's escape hatch into main-process
 * commands (dialogs, backend RPC, browser control). It must answer only the
 * app's own main window, never an embedded `WebContentsView` browser tab or
 * any other sender — the annotation channel exists precisely because this
 * handler used to check nothing (see `browser-annotation.ts`).
 *
 * Generic over the sender type, mirroring `acceptBrowserAnnotationMessage`,
 * so the check is unit-testable with a fake object instead of a real
 * `Electron.WebContents`.
 */
export function isTrustedInvokeSender<Sender>(input: {
  sender: Sender;
  mainWebContents: Sender | null;
}): boolean {
  return input.mainWebContents !== null && input.sender === input.mainWebContents;
}

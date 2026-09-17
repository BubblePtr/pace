import { describe, expect, it } from "vitest";
import { isTrustedInvokeSender } from "./ipc-sender-guard";

describe("isTrustedInvokeSender", () => {
  it("accepts the main window's own webContents", () => {
    const mainWebContents = { id: "main" };

    expect(
      isTrustedInvokeSender({ sender: mainWebContents, mainWebContents }),
    ).toBe(true);
  });

  it("rejects a different sender, such as an embedded WebContentsView", () => {
    const mainWebContents = { id: "main" };
    const embeddedViewSender = { id: "embedded-browser-view" };

    expect(
      isTrustedInvokeSender({ sender: embeddedViewSender, mainWebContents }),
    ).toBe(false);
  });

  it("rejects every sender when there is no main window yet", () => {
    const someSender = { id: "anything" };

    expect(
      isTrustedInvokeSender({ sender: someSender, mainWebContents: null }),
    ).toBe(false);
  });
});

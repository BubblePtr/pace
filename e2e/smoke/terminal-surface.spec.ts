import { expect, test } from "@playwright/test";
import { launchPace } from "../fixtures/electron-app";

/**
 * Terminal surface smoke: drives a real zsh through the utilityProcess backend
 * (node-pty over the RPC bridge) and back into xterm.js. Covers spawn, the
 * input/output round-trip, a second instance, and scrollback replay on tab
 * switch. xterm renders text into .xterm-rows DOM, so no canvas reading is
 * needed.
 */
test("Terminal surface runs a real shell, multi-instance, with replay", async () => {
  const testApp = await launchPace({ seedSession: true, seedPreflightAuth: true });

  try {
    await testApp.resizeWindow(1440, 900);

    const { window } = testApp;
    const newSession = window.getByRole("button", { name: "New Chat for E2E Project", exact: true });

    await expect(newSession).toBeVisible();
    await newSession.click();

    const session = window.getByRole("button", {
      name: new RegExp(`^${testApp.projection!.initialPrompt}`, "i"),
    });

    await expect(session).toBeVisible();
    await session.click();

    // Open the dock, then switch the rail to Terminal.
    const dockToggle = window.getByLabel("Session dock");

    await expect(dockToggle).toBeVisible();
    await dockToggle.click();

    const aside = window.getByTestId("session-dock");

    await expect(aside).toBeVisible();
    await aside.getByRole("button", { name: "Terminal" }).click();

    // Merely opening the surface must not start a shell.
    await expect(aside.getByText("No terminals open")).toBeVisible();
    await expect(aside.getByRole("tab")).toHaveCount(0);
    await expect(window.getByTestId("terminal-viewport")).toHaveCount(0);
    await aside.getByRole("button", { name: "New terminal" }).click();

    const viewport = window.getByTestId("terminal-viewport");
    const rows = viewport.locator(".xterm-rows");
    const input = viewport.getByRole("textbox", { name: "Terminal input", exact: true });

    await expect(aside.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
    await expect(rows).not.toHaveText(/^\s*$/, { timeout: 15_000 });

    // Input round-trip: type into xterm, the shell echoes the result back.
    await viewport.click();
    await expect(input).toBeFocused();
    // The output marker is absent from the command, so local echo cannot satisfy it.
    const firstCommand = "printf 'E2E_PTY_%s\\n' ONE";
    await input.pressSequentially(firstCommand);
    await expect(rows).toContainText(firstCommand);
    await input.press("Enter");
    await expect(rows).toContainText("E2E_PTY_ONE");

    // A second instance gets its own shell; output stays independent.
    await aside.getByRole("button", { name: "New terminal" }).click();

    const secondTab = aside.getByRole("tab", { name: "Terminal 2" });

    await expect(secondTab).toBeVisible();
    await viewport.click();
    await expect(input).toBeFocused();
    const secondCommand = "printf 'E2E_PTY_%s\\n' TWO";
    await input.pressSequentially(secondCommand);
    await expect(rows).toContainText(secondCommand);
    await input.press("Enter");
    await expect(rows).toContainText("E2E_PTY_TWO");
    await expect(rows).not.toContainText("E2E_PTY_ONE");

    // Switching back re-attaches and replays the first shell's scrollback.
    await aside.getByRole("tab", { name: "Terminal 1" }).click();
    await expect(rows).toContainText("E2E_PTY_ONE");

    // Closing the second tab leaves the first alive.
    await aside.getByRole("button", { name: "Close Terminal 2" }).click();
    await expect(secondTab).toHaveCount(0);
    await expect(rows).toContainText("E2E_PTY_ONE");

    await aside.getByRole("button", { name: "Close Terminal 1" }).click();
    await expect(aside.getByText("No terminals open")).toBeVisible();
    await aside.getByRole("button", { name: "Changes", exact: true }).click();
    await aside.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(aside.getByText("No terminals open")).toBeVisible();
    await expect(aside.getByRole("tab")).toHaveCount(0);
  } finally {
    await testApp.close();
  }
});

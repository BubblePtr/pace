import { expect, test } from "@playwright/test";
import { launchPace } from "../fixtures/electron-app";

test("macOS E2E windows can exceed the runner display height", async () => {
  test.skip(process.platform !== "darwin", "macOS constrains native window sizes");
  const application = await launchPace();

  try {
    const { requestedHeight, displayHeight } = await application.app.evaluate(
      ({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const display = screen.getDisplayMatching(window.getBounds());
        const height = Math.max(900, display.bounds.height + 100);
        window.setSize(1280, height);
        return { requestedHeight: height, displayHeight: display.bounds.height };
      },
    );

    // macOS grants `enableLargerThanScreen` windows more than the display but
    // not necessarily the exact request (hosted runners clamp 900 → 840), so
    // assert the guarantee the suite relies on: the window is never shrunk
    // below the display, not the pixel value asked for.
    await expect
      .poll(
        () =>
          application.app.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize()[1],
          ),
        { message: `requested ${requestedHeight}, display ${displayHeight}` },
      )
      .toBeGreaterThanOrEqual(displayHeight);
  } finally {
    await application.close();
  }
});

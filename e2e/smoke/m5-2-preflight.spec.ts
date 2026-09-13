import { expect, test } from "@playwright/test";
import { launchPace } from "../fixtures/electron-app";

test.describe("M5.2: First-run preflight", () => {
  test("cold start reaches preflight and keeps provider settings usable before setup completes", async ({}, testInfo) => {
    const testApp = await launchPace({ requirePreflight: true });

    try {
      await expect(testApp.window.getByText("Before your first session")).toBeVisible();
      await expect(testApp.window).toHaveURL(/#\/preflight$/);
      await testApp.window.getByRole("button", { name: /Configure providers/i }).click();
      await expect(testApp.window.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await testApp.window.keyboard.press("Escape");
      await expect(testApp.window.getByText("Before your first session")).toBeVisible();
      await expect(testApp.window).toHaveURL(/#\/preflight$/);
      await testApp.window.screenshot({ path: testInfo.outputPath("cold-start-preflight.png") });
    } finally {
      await testApp.close();
    }
  });

  test("gates first launch using the bundled engine without a global CLI", async ({}, testInfo) => {
    const testApp = await launchPace({
      requirePreflight: true,
      seedPreflightAuth: true,
      emptyPath: true,
    });

    try {
      await expect(testApp.window.getByText("Before your first session")).toBeVisible();
      await expect(testApp.window.getByText("Pi Runtime", { exact: true }).first()).toBeVisible();
      await expect(testApp.window.getByText("Data directory", { exact: true }).first()).toBeVisible();
      await expect(testApp.window.getByText("Model auth", { exact: true }).first()).toBeVisible();
      await expect(testApp.window.getByText("Git", { exact: true }).first()).toBeVisible();

      // Preflight is titlebar-only — no app navigation sidebar (DF-013).
      await expect(testApp.window.getByTestId("app-frame-titlebar-only")).toBeVisible();
      await expect(testApp.window.getByTestId("sidebar-projects")).toHaveCount(0);
      await expect(
        testApp.window.getByRole("button", { name: /Collapse sidebar|Expand sidebar/i }),
      ).toHaveCount(0);

      const continueButton = testApp.window.getByRole("button", { name: /Continue/i });
      await expect(continueButton).toBeEnabled({ timeout: 30_000 });
      await expect(testApp.window.getByText("Bundled Pi engine available")).toBeVisible();
      await expect(testApp.window.getByText(/Pace .* · Pi 0\.84\.3 · SDK/)).toBeVisible();
      await testApp.window.screenshot({ path: testInfo.outputPath("bundled-pi-preflight.png"), fullPage: true });
      await continueButton.click();

      await expect(testApp.window.getByRole("button", { name: /add project/i })).toBeVisible({
        timeout: 30_000,
      });
      await expect(testApp.window.getByText("Before your first session")).toHaveCount(0);
      // After Continue, main shell has sidebar again.
      await expect(testApp.window.getByTestId("sidebar-projects")).toBeVisible();
    } finally {
      await testApp.close();
    }
  });

  test("blocks Continue when model auth is missing", async () => {
    const testApp = await launchPace({
      requirePreflight: true,
      seedPreflightAuth: false,
    });

    try {
      await expect(testApp.window.getByText("Before your first session")).toBeVisible();
      await expect(testApp.window.getByText(/No provider credentials/i).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        testApp.window.getByRole("button", { name: /Continue \(disabled\)|Continue/i }),
      ).toBeDisabled();
    } finally {
      await testApp.close();
    }
  });

  test("keeps Continue enabled when optional Git is missing", async () => {
    const testApp = await launchPace({
      requirePreflight: true,
      seedPreflightAuth: true,
      forceGitMissing: true,
    });

    try {
      await expect(testApp.window.getByText("Before your first session")).toBeVisible();
      await expect(
        testApp.window.getByText(/Not installed — Changes \/ worktree limited/i).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(testApp.window.getByRole("button", { name: /Continue →/i })).toBeEnabled();
      await testApp.window.getByRole("button", { name: /Continue →/i }).click();
      await expect(testApp.window.getByRole("button", { name: /add project/i })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await testApp.close();
    }
  });
});

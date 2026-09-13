import { expect, test } from "@playwright/test";
import { createSubagentObservationFixture } from "../fixtures/subagent-observation";

test("the packaged subagent panel opens the child from its parent tool, shows live trace, and stops idle-parent work", async () => {
  const run = await createSubagentObservationFixture();
  try {
    await run.app.resizeWindow(1440, 1000);
    const root = await run.create("ui-observation");
    const child = await run.spawn(root, "visible-child");
    await run.page.evaluate((cwd) => {
      window.location.hash = `/projects/${encodeURIComponent(cwd)}/sessions`;
    }, run.app.project!.path);
    await run.page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      run.page.getByRole("button", { name: "1 active subagents" }),
    ).toBeVisible();
    const link = run.page.getByRole("button", {
      name: "View observation-worker subagent",
    });
    await expect(link).toBeVisible();
    await link.click();
    const panel = run.page.getByTestId("session-subagents-panel");
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText("visible-child", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("CHILD:visible-child", { exact: true })).toBeVisible();
    (await run.gate("visible-child:before-read")).release();
    await run.gate("visible-child:after-read");
    await panel.getByRole("button", { name: "Trace", exact: true }).click();
    await panel.getByRole("button", { name: /^tool\s*read/ }).click();
    await panel.getByRole("tab", { name: "Payload", exact: true }).click();
    await expect(
      panel.locator('[data-slot="trajectory-inspector"]'),
    ).toContainText('"path": "observation-probe.txt"');
    await panel.getByRole("tab", { name: "Schema", exact: true }).click();
    await expect(
      panel.locator('[data-slot="trajectory-inspector"]'),
    ).toContainText('"path"');
    await panel.getByRole("tab", { name: "Result", exact: true }).click();
    await expect(
      panel.locator('[data-slot="trajectory-inspector"]'),
    ).toContainText("READ_FROM_ALPHA");
    await run.page.screenshot({
      path: test.info().outputPath("subagent-live-trace.png"),
    });
    await test.info().attach("packaged-subagent-live-trace", {
      path: test.info().outputPath("subagent-live-trace.png"),
      contentType: "image/png",
    });
    await panel.getByRole("button", { name: "Parent session" }).click();
    await expect(link).toBeFocused();
    await expect(panel).not.toBeVisible();
    await expect(
      run.page.getByRole("button", { name: "Stop all work" }),
    ).toBeVisible();
    await run.page.screenshot({
      path: test.info().outputPath("idle-parent-active-child.png"),
    });
    await test.info().attach("packaged-idle-parent-active-child", {
      path: test.info().outputPath("idle-parent-active-child.png"),
      contentType: "image/png",
    });
    await run.page.getByRole("button", { name: "Stop all work" }).click();
    await expect
      .poll(async () => (await run.gate("visible-child:after-read")).closed)
      .toBe(true);
    await expect
      .poll(async () => (await run.detail(root, child.id)).record.status)
      .toBe("stopped");
    await expect(
      run.page.getByRole("button", { name: "1 active subagents" }),
    ).not.toBeVisible();
    await run.page.reload({ waitUntil: "domcontentloaded" });
    await run.page
      .getByRole("button", { name: "View observation-worker subagent" })
      .click();
    await expect(panel.getByText("stopped", { exact: true })).toBeVisible();
    await expect(panel.getByText("CHILD:visible-child", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Trace", exact: true }).click();
    await panel.getByRole("button", { name: /^tool\s*read/ }).click();
    await panel.getByRole("tab", { name: "Result", exact: true }).click();
    await expect(
      panel.locator('[data-slot="trajectory-inspector"]'),
    ).toContainText("READ_FROM_ALPHA");
    await expect(
      panel.getByRole("button", { name: "Stop subagent" }),
    ).not.toBeVisible();
    await run.page.screenshot({
      path: test.info().outputPath("subagent-history.png"),
    });
    await test.info().attach("packaged-subagent-history", {
      path: test.info().outputPath("subagent-history.png"),
      contentType: "image/png",
    });
  } finally {
    await run.close();
  }
});

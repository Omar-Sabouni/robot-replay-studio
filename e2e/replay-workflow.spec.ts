import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

function parseTimecode(value: string): number {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Unable to parse replay timecode: ${value}`);
  }
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) {
    throw new Error(`Unable to parse replay timecode: ${value}`);
  }
  return hours * 3_600 + minutes * 60 + seconds;
}

async function readTimecode(locator: Locator): Promise<number> {
  return parseTimecode(await locator.innerText());
}

async function seekTo(page: Page, timestamp: number): Promise<void> {
  await page.locator("#scrubber").evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, timestamp);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

function monitorBrowserErrors(page: Page, allowedConsole: readonly RegExp[] = []): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const text = message.text();
    if (!allowedConsole.some((pattern) => pattern.test(text))) {
      errors.push(`console: ${text}`);
    }
  });
  return errors;
}

async function openEastLoop(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /East Loop safety intervention/ })).toBeVisible();
  await expect(page.locator("#mission-run-summary")).toContainText("Candidate + baseline");
  await expect(page.locator("#mission-run-summary")).toContainText("20 Hz");
  await expect(page.locator("#event-list .event-card").first()).toBeAttached();
}

test("mission catalogue, detector sequence, and replay clock stay synchronized", async ({
  page,
}) => {
  const browserErrors = monitorBrowserErrors(page);
  await openEastLoop(page);

  await expect(page.locator("#outcome-state")).toContainText("Safe-stop");
  await expect(page.locator("#evidence-chain-list [data-incident-id]").first()).toBeVisible();
  await expect(page.locator("#detected-stat")).not.toHaveText("0");
  await expect(page.locator("#scene-mount canvas")).toHaveCount(1);

  const unselectedIncident = page.locator("#event-list .event-card:not(.active)").first();
  const incidentId = await unselectedIncident.getAttribute("data-incident-id");
  const incidentTimestamp = Number(await unselectedIncident.getAttribute("data-timestamp"));
  const incidentTitle = (await unselectedIncident.locator("strong").innerText()).trim();
  expect(incidentId).not.toBeNull();
  expect(incidentTimestamp).toBeGreaterThan(0);
  await unselectedIncident.click();

  const selectedIncident = page.locator(`[data-incident-id="${incidentId ?? ""}"]`).first();
  await expect(selectedIncident).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#inspector-title")).toHaveText(incidentTitle);
  await expect(page.locator("#evidence-observed")).not.toHaveText("—");
  await expect(page.locator("#evidence-threshold")).not.toHaveText("—");
  expect(await readTimecode(page.locator("#current-timecode"))).toBeCloseTo(incidentTimestamp, 3);

  const detectorStep = page.locator("#evidence-chain-list button[data-incident-id]").last();
  const detectorIncidentId = await detectorStep.getAttribute("data-incident-id");
  await detectorStep.click();
  await expect(
    page.locator(`#event-list [data-incident-id="${detectorIncidentId ?? ""}"]`),
  ).toHaveAttribute("aria-current", "true");

  const playPause = page.locator("#play-pause");
  const timecode = page.locator("#current-timecode");
  const initialTime = await readTimecode(timecode);
  await expect(playPause).toHaveAccessibleName("Play replay");
  await playPause.click();
  await expect(playPause).toHaveAccessibleName("Pause replay");
  await expect.poll(() => readTimecode(timecode)).toBeGreaterThan(initialTime + 0.05);
  await playPause.click();
  const pausedTime = await readTimecode(timecode);
  await page.waitForTimeout(180);
  expect(await readTimecode(timecode)).toBe(pausedTime);

  await page.locator("#inspector-tab-sample").click();
  await seekTo(page, 17.95);
  const poseBeforeGap = await page.locator("#pose-x").innerText();
  const poseYBeforeGap = await page.locator("#pose-y").innerText();
  await seekTo(page, 18.3);
  await expect(page.locator("#sample-freshness")).toHaveAttribute("data-status", "held-during-gap");
  await expect(page.locator("#diagnostic-relation")).toHaveText("Telemetry gap");
  await expect(page.locator("#pose-x")).toHaveText(poseBeforeGap);
  await expect(page.locator("#charts svg")).toContainText("NO DATA");
  await seekTo(page, 18.75);
  await expect(page.locator("#sample-freshness")).toHaveAttribute("data-status", "exact");
  await expect(page.locator("#pose-y")).not.toHaveText(poseYBeforeGap);

  const comparison = page.locator("#scene-stage");
  await page.getByRole("button", { name: "Candidate", exact: true }).click();
  await expect(comparison).toHaveAttribute("data-comparison", "false");
  await page.getByRole("button", { name: "Overlay", exact: true }).click();
  await expect(comparison).toHaveAttribute("data-comparison", "true");
  expect(browserErrors).toEqual([]);
});

test("scenario changes re-run analysis and preserve mission-specific outcomes", async ({
  page,
}) => {
  const browserErrors = monitorBrowserErrors(page);
  await openEastLoop(page);

  const missionSelector = page.locator("#mission-selector");
  await missionSelector.selectOption("wheel-slip-drift");
  await expect(page.getByRole("heading", { name: /Wheel-slip heading drift/ })).toBeVisible();
  await expect(page.locator("#outcome-state")).toContainText("Degraded");
  await expect(page.locator("#mission-run-summary")).toContainText("Candidate");
  await expect(page.locator("#event-list .event-card").first()).toBeVisible();

  await missionSelector.selectOption("steady-route");
  await expect(page.getByRole("heading", { name: /Steady route/ })).toBeVisible();
  await expect(page.locator("#outcome-state")).toContainText("Nominal");
  await expect(page.locator("#event-empty")).toContainText("No incidents detected");
  await expect(page.locator("#detected-stat")).toHaveText("0");

  await missionSelector.selectOption("east-loop-incident");
  await expect(page.getByRole("heading", { name: /East Loop safety intervention/ })).toBeVisible();
  await expect(page.locator("#event-list .event-card").first()).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("saved links for the renamed route resolve to the current scenario", async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  const previousRouteId = ["nominal", "validation"].join("-");
  await page.goto(`?scenario=${previousRouteId}`);

  await expect(page.getByRole("heading", { name: /Steady route/ })).toBeVisible();
  await expect(page.locator("#mission-selector")).toHaveValue("steady-route");
  await expect(page).toHaveURL(/scenario=steady-route/);
  expect(browserErrors).toEqual([]);
});

test("Fault Lab creates a non-destructive branch and restores the source session", async ({
  page,
}) => {
  const browserErrors = monitorBrowserErrors(page);
  await openEastLoop(page);
  await seekTo(page, 12);

  await page.locator("#fault-open").click();
  const dialog = page.getByRole("dialog", { name: "Fault Lab" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#fault-anchor-time")).toHaveText("00:12.000");
  await page.locator("#fault-duration").fill("1.5");
  await expect(page.locator("#fault-preview")).toContainText("29 samples removed");
  await page.locator("#fault-apply").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#toast-text")).toContainText("Packet dropout branch ready");
  await expect(page.locator("#mission-run-summary")).toContainText("Candidate + baseline");

  await page.locator("#fault-open").click();
  await page.locator("#fault-reset").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#toast-text")).toContainText("Fault Lab branch reset");
  await expect(page.locator("#mission-run-summary")).toContainText("Candidate + baseline");
  expect(browserErrors).toEqual([]);
});

test("local CSV import and the live simulator require no backend", async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await openEastLoop(page);

  await page.locator("#import-open").click();
  const importDialog = page.getByRole("dialog", { name: "Import telemetry" });
  await expect(importDialog).toBeVisible();
  await expect(importDialog).toContainText("processed in this browser");
  await page.locator("#import-format").selectOption("csv");
  await page.locator("#import-file").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("timestamp,x,y,yaw\n0,not-a-number,0,0"),
  });
  await page.locator("#import-submit").click();
  const importAlert = importDialog.getByRole("alert");
  await expect(importAlert).toHaveText("Some required telemetry fields are missing or invalid.");
  await expect(importAlert).not.toContainText(/rows\[|not-a-number/i);

  const csv = [
    "timestamp,x,y,yaw,sequence,speed,battery,current,state,latency_ms,pose_sigma",
    "10.00,0.00,0.00,0.00,100,0.50,88.0,4.2,autonomous,24,0.03",
    "10.05,0.03,0.00,0.01,101,0.60,87.9,4.5,autonomous,25,0.03",
    "10.10,0.07,0.00,0.01,102,0.70,87.8,4.8,autonomous,26,0.03",
    "10.15,0.11,0.01,0.02,103,0.75,87.7,5.0,autonomous,27,0.03",
  ].join("\n");
  await page.locator("#import-file").setInputFiles({
    name: "local-capture.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await expect(page.locator("#import-submit")).toBeEnabled();
  await page.locator("#import-submit").click();
  await expect(importDialog.getByRole("alert")).toContainText(
    "Import completed with 2 normalization notes",
  );
  await importDialog.getByRole("button", { name: "Close import dialog" }).click();
  await expect(importDialog).toBeHidden();
  await expect(page.getByRole("heading", { name: /local-capture/i })).toBeVisible();
  await expect(page.locator("#mission-run-summary")).toContainText("Candidate · 4 samples");
  await expect(page.locator("#sample-stat")).toHaveText("4 samples");

  await page.locator("#live-open").click();
  const liveDialog = page.getByRole("dialog", { name: "Live telemetry" });
  await expect(liveDialog).toBeVisible();
  await expect(liveDialog).toContainText("20 Hz local stream");
  await page.locator("#live-connect").click();
  await expect(page.locator("#live-connect")).toHaveText("Disconnect");
  await expect(page.locator("#connection-state-label")).toHaveText("Live");
  await expect(page.locator("#connection-state-detail")).toContainText("captured locally");
  await page.locator("#live-connect").click();
  await expect(liveDialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: /Warehouse AMR — localization incident/ }),
  ).toBeVisible();
  await expect(page.locator("#mission-run-summary")).toContainText("Candidate");
  expect(browserErrors).toEqual([]);
});

test("incident report exports detector results", async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page);
  await openEastLoop(page);

  const exportButton = page.getByRole("button", { name: "Export incident report" });
  await exportButton.focus();
  await exportButton.press("Enter");
  await expect(exportButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#export-scope")).toContainText("Candidate + baseline");
  const jsonAction = page
    .getByRole("group", { name: "Export report" })
    .getByRole("button", { name: /JSON report/ });
  await expect(jsonAction).toBeFocused();

  const downloadPromise = page.waitForEvent("download");
  await jsonAction.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("rpl-042-east-loop-safety-intervention.json");
  const path = await download.path();
  expect(path).not.toBeNull();
  const report = JSON.parse(await readFile(path!, "utf8")) as {
    summary: { runCount: number; anomalyCount: number };
    detectorConfigurations?: unknown[];
    evidenceRanges?: unknown[];
    evidenceChain?: unknown[];
  };
  expect(report.summary.runCount).toBe(2);
  expect(report.summary.anomalyCount).toBeGreaterThan(0);
  expect(report.detectorConfigurations?.length).toBeGreaterThanOrEqual(5);
  expect(report.evidenceRanges?.length).toBe(report.summary.anomalyCount);
  expect(report.evidenceChain?.length).toBeGreaterThan(1);
  await expect(exportButton).toHaveAttribute("aria-expanded", "false");
  expect(browserErrors).toEqual([]);
});

test("mobile workbench uses real task tabs and remains usable through desktop widths", async ({
  page,
}) => {
  const browserErrors = monitorBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await openEastLoop(page);

  const replayTab = page.locator("#mobile-tab-replay");
  const incidentsTab = page.locator("#mobile-tab-incidents");
  const evidenceTab = page.locator("#mobile-tab-evidence");
  const signalsTab = page.locator("#mobile-tab-signals");
  await expect(replayTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#mobile-panel-replay")).toBeVisible();
  await expect(page.locator("#mobile-panel-incidents")).toBeHidden();
  await expect(page.locator(".transport-dock")).toBeVisible();

  await incidentsTab.click();
  await expect(incidentsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#mobile-panel-incidents")).toBeVisible();
  await expect(page.locator("#mobile-panel-replay")).toBeHidden();
  await page.locator("#event-list .event-card").first().click();
  await expect(evidenceTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#mobile-panel-evidence")).toBeVisible();

  await signalsTab.click();
  await expect(page.locator("#charts")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  for (const width of [320, 760, 768, 1_024, 1_440]) {
    await page.setViewportSize({ width, height: width <= 760 ? 900 : 1_000 });
    await expect(page.getByRole("button", { name: "Export incident report" })).toBeVisible();
    await expect(page.locator(".transport-dock")).toBeVisible();
    if (width <= 760) {
      await expect(page.locator("#mobile-tabs")).toBeVisible();
    } else {
      await expect(page.locator("#mobile-panel-replay")).toBeVisible();
      await expect(page.locator("#mobile-panel-incidents")).toBeVisible();
      await expect(page.locator("#mobile-panel-evidence")).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
  }
  expect(browserErrors).toEqual([]);
});

test("keyboard shortcuts and top-down fallback keep analysis functional", async ({ page }) => {
  const browserErrors = monitorBrowserErrors(page, [/WebGL/i, /Error creating WebGL context/i]);
  await page.addInitScript({
    content: `
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (String(type).toLowerCase().includes('webgl')) return null;
        return originalGetContext.call(this, type, ...args);
      };
    `,
  });
  await openEastLoop(page);

  const fallback = page.locator(".spatial-fallback");
  await expect(fallback).toHaveAttribute("data-state", "unavailable");
  await expect(fallback).toContainText("top-down replay active");
  await expect(fallback.locator("svg")).toBeVisible();
  await expect(page.locator("#scene-mount canvas")).toHaveCount(0);

  const timecode = page.locator("#current-timecode");
  const before = await readTimecode(timecode);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ArrowRight");
  expect((await readTimecode(timecode)) - before).toBeCloseTo(0.1, 3);
  await page.keyboard.press("Shift+ArrowRight");
  expect((await readTimecode(timecode)) - before).toBeCloseTo(1.1, 3);
  await page.keyboard.press("Space");
  await expect(page.locator("#play-pause")).toHaveAccessibleName("Pause replay");
  await page.keyboard.press("Space");
  await expect(page.locator("#play-pause")).toHaveAccessibleName("Play replay");

  await seekTo(page, 18.3);
  await page.locator("#inspector-tab-sample").click();
  await expect(page.locator("#sample-freshness")).toHaveAttribute("data-status", "held-during-gap");
  await expect(page.locator("#charts")).toBeVisible();
  await expect(page.locator("#event-list .event-card")).not.toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoSeriousAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(serious).toEqual([]);
}

test("desktop, mobile task views, and modal states have no serious accessibility violations", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /East Loop safety intervention/ })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.locator("#fault-open").click();
  const faultDialog = page.getByRole("dialog", { name: "Fault Lab" });
  await expect(faultDialog).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  await page.keyboard.press("Escape");
  await expect(faultDialog).toBeHidden();
  await expect(page.locator("#fault-open")).toBeFocused();

  await page.setViewportSize({ width: 390, height: 900 });
  const mobileTabs = page.getByRole("tablist", { name: "Workbench views" });
  const replayTab = mobileTabs.getByRole("tab", { name: "Replay" });
  const incidentsTab = mobileTabs.getByRole("tab", { name: /Incidents/ });
  const evidenceTab = mobileTabs.getByRole("tab", { name: "Detector" });
  const signalsTab = mobileTabs.getByRole("tab", { name: "Signals" });

  await page.setViewportSize({ width: 390, height: 500 });
  const mobileTabsDocumentTop = await mobileTabs.evaluate(
    (element) => element.getBoundingClientRect().top + window.scrollY,
  );
  await page.evaluate((top) => window.scrollTo({ top: top + 50 }), mobileTabsDocumentTop);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(mobileTabsDocumentTop);
  const stickyTabOffset = await mobileTabs.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  expect(Math.abs(stickyTabOffset)).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.setViewportSize({ width: 390, height: 900 });

  await replayTab.focus();
  for (const tab of [incidentsTab, evidenceTab, signalsTab]) {
    await page.keyboard.press("ArrowRight");
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toBeFocused();
    await expectNoSeriousAccessibilityViolations(page);
  }
  await page.keyboard.press("Home");
  await expect(replayTab).toHaveAttribute("aria-selected", "true");
  await expect(replayTab).toBeFocused();

  await evidenceTab.click();
  const chainStep = page.locator("#evidence-chain-list button[data-incident-id]").last();
  const chainIncidentId = await chainStep.getAttribute("data-incident-id");
  expect(chainIncidentId).not.toBeNull();
  await chainStep.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(`#evidence-chain-list button[data-incident-id="${chainIncidentId ?? ""}"]`),
  ).toBeFocused();

  await evidenceTab.focus();
  await page.setViewportSize({ width: 768, height: 1_000 });
  await expect
    .poll(() =>
      page
        .locator("#mobile-panel-evidence")
        .evaluate((panel) => panel.contains(document.activeElement)),
    )
    .toBe(true);
  await expect(page.locator(".camera-segment")).toBeVisible();
  expect(
    await page.locator("#mission-title").evaluate((title) => {
      const style = getComputedStyle(title);
      return (
        style.whiteSpace === "normal" &&
        style.textOverflow !== "ellipsis" &&
        title.scrollWidth <= title.clientWidth + 1
      );
    }),
  ).toBe(true);

  await page.locator("#incident-search").focus();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(evidenceTab).toBeFocused();
  expect(
    await page.locator(".evidence-chain strong").evaluateAll((labels) =>
      labels.every((label) => {
        const style = getComputedStyle(label);
        return (
          style.whiteSpace === "normal" &&
          style.textOverflow !== "ellipsis" &&
          label.scrollWidth <= label.clientWidth + 1
        );
      }),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);

  await replayTab.click();
  const sceneCanvas = page.locator("#scene-mount canvas");
  await expect(sceneCanvas).toBeAttached();
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(sceneCanvas).toHaveCSS("touch-action", "pan-y pinch-zoom");
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await expect(sceneCanvas).toHaveCSS("touch-action", "none");

  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  await page.locator("#fault-open").click();
  await expect(faultDialog).toBeVisible();
  const footerFits = await faultDialog.locator(".modal-footer").evaluate((footer) => {
    const bounds = footer.getBoundingClientRect();
    return (
      footer.scrollWidth <= footer.clientWidth + 1 &&
      [...footer.querySelectorAll<HTMLElement>("button")].every((button) => {
        const buttonBounds = button.getBoundingClientRect();
        return buttonBounds.left >= bounds.left - 1 && buttonBounds.right <= bounds.right + 1;
      })
    );
  });
  expect(footerFits).toBe(true);
  await page.keyboard.press("Escape");
});

test("workbench exposes semantic state, reading order, and visible keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await page.goto("/");
  await expect(page.locator("#event-list .event-card").first()).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (selector: string): DOMRect => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      return element.getBoundingClientRect();
    };
    const events = rect(".events-panel");
    const scene = rect(".viewport-panel");
    const inspector = rect(".detail-panel");
    const timeline = rect(".timeline-panel");
    const telemetry = rect(".telemetry-panel");
    return {
      events: { left: events.left, right: events.right },
      scene: { left: scene.left, right: scene.right, bottom: scene.bottom },
      inspector: { left: inspector.left, right: inspector.right },
      timeline: {
        left: timeline.left,
        right: timeline.right,
        top: timeline.top,
        bottom: timeline.bottom,
      },
      telemetry: {
        left: telemetry.left,
        right: telemetry.right,
        top: telemetry.top,
        bottom: telemetry.bottom,
      },
    };
  });

  expect(geometry.events.right).toBeLessThanOrEqual(geometry.scene.left + 1);
  expect(geometry.scene.right).toBeLessThanOrEqual(geometry.inspector.left + 1);
  expect(geometry.timeline.top).toBeGreaterThanOrEqual(geometry.scene.bottom - 1);
  expect(geometry.timeline.left).toBeLessThanOrEqual(geometry.events.left + 1);
  expect(geometry.timeline.right).toBeLessThanOrEqual(geometry.telemetry.left + 1);
  expect(Math.abs(geometry.timeline.top - geometry.telemetry.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.timeline.bottom - geometry.telemetry.bottom)).toBeLessThanOrEqual(1);
  expect(geometry.telemetry.right).toBeGreaterThanOrEqual(geometry.inspector.right - 1);

  const selectedIncident = page.locator("#event-list .event-card.active");
  await expect(selectedIncident).toHaveAttribute("aria-current", "true");
  const selectedId = await selectedIncident.getAttribute("data-incident-id");
  await expect(
    page.locator(`#timeline-markers [data-incident-id="${selectedId ?? ""}"]`),
  ).toHaveAttribute("aria-current", "true");
  const timelineMarker = page.locator("#timeline-markers .timeline-marker").last();
  const timelineIncidentId = await timelineMarker.getAttribute("data-incident-id");
  expect(timelineIncidentId).not.toBeNull();
  await timelineMarker.click();
  const selectedTimelineMarker = page.locator(
    `#timeline-markers [data-incident-id="${timelineIncidentId ?? ""}"]`,
  );
  await expect(selectedTimelineMarker).toHaveAttribute("aria-current", "true");
  await selectedTimelineMarker.focus();
  await page.keyboard.press("Enter");
  await expect(selectedTimelineMarker).toBeFocused();
  const timelineGap = page.locator("#timeline-gaps .timeline-gap").first();
  await timelineGap.click();
  await expect(timelineGap).toBeFocused();
  await expect(page.locator("#inspector-tab-evidence")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#inspector-panel-evidence")).toBeVisible();
  await expect(page.locator("#inspector-panel-sample")).toBeHidden();
  await page.locator("#inspector-tab-evidence").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#inspector-tab-sample")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#inspector-tab-sample")).toBeFocused();
  await expect(page.locator("#inspector-panel-sample")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#inspector-tab-evidence")).toHaveAttribute("aria-selected", "true");

  const critical = page.locator(".event-card.critical .event-icon").first();
  const warning = page.locator(".event-card.warning .event-icon").first();
  await expect(critical).toBeVisible();
  await expect(warning).toBeVisible();
  expect(await critical.evaluate((element) => getComputedStyle(element).color)).not.toBe(
    await warning.evaluate((element) => getComputedStyle(element).color),
  );

  const exportButton = page.getByRole("button", { name: "Export incident report" });
  await exportButton.focus();
  await expect(exportButton).toBeFocused();
  await exportButton.press("Enter");
  await expect(exportButton).toHaveAttribute("aria-expanded", "true");
  const exportGroup = page.getByRole("group", { name: "Export report" });
  await expect(exportGroup.getByRole("button", { name: /JSON report/ })).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(exportGroup.getByRole("button", { name: /Markdown brief/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(exportButton).toHaveAttribute("aria-expanded", "false");
  await expect(exportButton).toBeFocused();
});

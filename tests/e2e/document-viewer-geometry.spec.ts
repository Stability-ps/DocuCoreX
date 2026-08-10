import { expect, test, type Page } from "@playwright/test";

const VIEWER_ROUTE = "/dev/viewer-geometry";

type GeometrySnapshot = {
  container: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number; scrollLeft: number; scrollTop: number; left: number; right: number; top: number; bottom: number };
  surface: { width: number; height: number; left: number; right: number; top: number; bottom: number };
  canvas: { width: number; height: number; left: number; right: number; top: number; bottom: number };
  maxScrollLeft: number;
  maxScrollTop: number;
};

async function clickToolbarButton(page: Page, label: string) {
  await page.getByRole("button", { name: label }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
}

async function zoomUntilOverflow(page: Page, threshold = 150) {
  for (let i = 0; i < 16; i += 1) {
    const percentText = (await page.locator("span.min-w-12").first().textContent()) ?? "0%";
    const currentPercent = Number.parseInt(percentText, 10);
    if (currentPercent >= threshold) break;
    await clickToolbarButton(page, "Zoom in");
    await page.waitForTimeout(120);
  }
  await page.waitForFunction(() => {
    const container = document.querySelector("[data-testid='document-viewer-scroll-container']") as HTMLDivElement | null;
    const canvas = document.querySelector("[data-testid='document-viewer-canvas']") as HTMLCanvasElement | null;
    if (!container || !canvas) return false;
    return canvas.getBoundingClientRect().width > container.clientWidth + 1 && container.scrollWidth > container.clientWidth + 1;
  });
}

async function zoomUntilTwoAxisOverflow(page: Page, threshold = 200) {
  for (let i = 0; i < 20; i += 1) {
    const geometry = await getGeometry(page);
    const hasX = geometry.maxScrollLeft > 0;
    const hasY = geometry.maxScrollTop > 0;
    if (hasX && hasY) return;
    await zoomUntilOverflow(page, threshold + i * 10);
  }
}

async function getGeometry(page: Page): Promise<GeometrySnapshot> {
  return await page.evaluate(() => {
    const container = document.querySelector("[data-testid='document-viewer-scroll-container']") as HTMLDivElement | null;
    const surface = document.querySelector("[data-testid='document-viewer-surface']") as HTMLDivElement | null;
    const canvas = document.querySelector("[data-testid='document-viewer-canvas']") as HTMLCanvasElement | null;
    if (!container || !surface || !canvas) {
      throw new Error("Missing document viewer geometry nodes");
    }
    const containerRect = container.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      container: {
        clientWidth: container.clientWidth,
        clientHeight: container.clientHeight,
        scrollWidth: container.scrollWidth,
        scrollHeight: container.scrollHeight,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
        left: containerRect.left,
        right: containerRect.right,
        top: containerRect.top,
        bottom: containerRect.bottom,
      },
      surface: {
        width: surfaceRect.width,
        height: surfaceRect.height,
        left: surfaceRect.left,
        right: surfaceRect.right,
        top: surfaceRect.top,
        bottom: surfaceRect.bottom,
      },
      canvas: {
        width: canvasRect.width,
        height: canvasRect.height,
        left: canvasRect.left,
        right: canvasRect.right,
        top: canvasRect.top,
        bottom: canvasRect.bottom,
      },
      maxScrollLeft: container.scrollWidth - container.clientWidth,
      maxScrollTop: container.scrollHeight - container.clientHeight,
    };
  });
}

test.describe("Shared DocumentViewer zoom/pan geometry", () => {
  test("desktop: zoom overflow keeps both horizontal edges reachable and supports drag-pan", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Desktop geometry is validated once.");
    await page.goto(VIEWER_ROUTE);
    await page.waitForSelector("[data-testid='document-viewer-canvas']");
    await zoomUntilOverflow(page, 200);
    await zoomUntilTwoAxisOverflow(page, 200);

    const base = await getGeometry(page);
    expect(base.container.scrollWidth).toBeGreaterThan(base.container.clientWidth);
    expect(base.canvas.width).toBeGreaterThan(base.container.clientWidth);
    expect(base.maxScrollLeft).toBeGreaterThan(0);
    expect(base.maxScrollTop).toBeGreaterThanOrEqual(0);

    await page.evaluate(() => {
      const container = document.querySelector("[data-testid='document-viewer-scroll-container']") as HTMLDivElement;
      container.scrollTo({ left: 0, top: 0 });
    });
    const atLeft = await getGeometry(page);
    expect(atLeft.canvas.left).toBeGreaterThanOrEqual(atLeft.container.left - 2);

    await page.evaluate(() => {
      const container = document.querySelector("[data-testid='document-viewer-scroll-container']") as HTMLDivElement;
      container.scrollTo({ left: (container.scrollWidth - container.clientWidth) * 0.25, top: (container.scrollHeight - container.clientHeight) * 0.25 });
    });
    const middle = await getGeometry(page);
    expect(middle.container.scrollLeft).toBeGreaterThan(0);
    expect(middle.container.scrollLeft).toBeLessThan(middle.maxScrollLeft);

    const startScroll = middle.container.scrollLeft;
    const dragStart = await page.evaluate(() => {
      const container = document.querySelector("[data-testid='document-viewer-scroll-container']") as HTMLDivElement;
      const rect = container.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x - 140, dragStart.y, { steps: 8 });
    await page.mouse.up();
    const afterDragLeft = await getGeometry(page);
    expect(afterDragLeft.container.scrollLeft).toBeGreaterThan(startScroll + 5);

    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 140, dragStart.y, { steps: 8 });
    await page.mouse.up();
    const afterDragRight = await getGeometry(page);
    expect(afterDragRight.container.scrollLeft).toBeLessThan(afterDragLeft.container.scrollLeft - 5);

    await page.evaluate(() => {
      const container = document.querySelector("[data-testid='document-viewer-scroll-container']") as HTMLDivElement;
      container.scrollTo({ left: container.scrollWidth - container.clientWidth, top: container.scrollHeight - container.clientHeight });
    });
    const atRight = await getGeometry(page);
    const horizontalGap = atRight.container.right - atRight.canvas.right;
    const verticalGap = atRight.container.bottom - atRight.canvas.bottom;
    expect(horizontalGap).toBeGreaterThanOrEqual(-2);
    expect(horizontalGap).toBeLessThanOrEqual(14);
    expect(verticalGap).toBeGreaterThanOrEqual(-2);
    expect(verticalGap).toBeLessThanOrEqual(14);

    await page.getByRole("button", { name: "Jump to page 2" }).click();
    await expect(page.getByText("2 / 14")).toBeVisible();
    const afterJump = await getGeometry(page);
    expect(afterJump.container.scrollLeft).toBe(0);
    expect(afterJump.container.scrollTop).toBe(0);
    expect(afterJump.container.scrollWidth).toBeGreaterThan(afterJump.container.clientWidth);

    await clickToolbarButton(page, "Fit width");
    await page.waitForTimeout(200);
    const fit = await getGeometry(page);
    expect(fit.container.scrollLeft).toBe(0);
    expect(fit.container.scrollTop).toBe(0);
    if (fit.canvas.width <= fit.container.clientWidth - 2) {
      const leftGap = fit.canvas.left - fit.container.left;
      const rightGap = fit.container.right - fit.canvas.right;
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);
    }
  });

  test("mobile: zoomed document can pan fully in both directions", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Mobile geometry is validated in the mobile project.");
    await page.goto(VIEWER_ROUTE);
    await page.waitForSelector("[data-testid='document-viewer-canvas']");
    await zoomUntilOverflow(page, 150);

    await page.evaluate(() => {
      const container = document.querySelector("[data-testid='document-viewer-scroll-container']") as HTMLDivElement;
      container.scrollTo({ left: 0, top: 0 });
    });
    const atLeft = await getGeometry(page);
    expect(atLeft.container.scrollWidth).toBeGreaterThan(atLeft.container.clientWidth);
    expect(atLeft.canvas.left).toBeGreaterThanOrEqual(atLeft.container.left - 2);

    await page.evaluate(() => {
      const container = document.querySelector("[data-testid='document-viewer-scroll-container']") as HTMLDivElement;
      container.scrollTo({ left: container.scrollWidth - container.clientWidth, top: container.scrollHeight - container.clientHeight });
    });
    const atRight = await getGeometry(page);
    const horizontalGap = atRight.container.right - atRight.canvas.right;
    const verticalGap = atRight.container.bottom - atRight.canvas.bottom;
    expect(horizontalGap).toBeGreaterThanOrEqual(-2);
    expect(horizontalGap).toBeLessThanOrEqual(14);
    expect(verticalGap).toBeGreaterThanOrEqual(-2);
    expect(verticalGap).toBeLessThanOrEqual(14);
  });
});

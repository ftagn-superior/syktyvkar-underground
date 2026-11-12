import type { Page } from 'playwright';

export async function waitForCamera(page: Page): Promise<void> {
  await page.waitForFunction(() => !(window as any).__SU_DEBUG__.report().rendering.camera.turning);
}

/** Use the player's mouse gesture to request an exact angle, independent of frame timing. */
export async function rotateCamera(page: Page, radians: number, settle = true): Promise<void> {
  const canvas = page.locator('#world');
  await canvas.focus();
  const start = await canvas.evaluate((node, direction) => {
    const bounds = node.getBoundingClientRect();
    for (const x of [direction > 0 ? 0.9 : 0.1, 0.5, 0.95, 0.05])
      for (const y of [0.5, 0.25, 0.75, 0.15, 0.85]) {
        const point = { x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y };
        if (document.elementFromPoint(point.x, point.y) === node) return point;
      }
    throw new Error('No exposed canvas point for camera drag');
  }, radians);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'right' });
  try {
    await page.mouse.move(start.x - radians / 0.005, start.y);
  } finally {
    await page.mouse.up({ button: 'right' });
  }
  if (settle) await waitForCamera(page);
}

export async function holdCamera(page: Page, key: 'q' | 'e', milliseconds = 250): Promise<void> {
  await page.locator('#world').focus();
  await page.keyboard.down(key);
  try {
    await page.waitForTimeout(milliseconds);
  } finally {
    await page.keyboard.up(key);
  }
  await waitForCamera(page);
}

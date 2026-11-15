import assert from 'node:assert/strict';
import type { Page } from 'playwright';

/** The same 30-second near route on both versions, with raw RAF intervals. */
export async function cityLodWalk(page: Page) {
  // Keep this browser-only RAF closure outside tsx's named-function transform.
  const origin = await page.evaluate<{ x: number; y: number; z: number }>(`(() => {
    const w = window;
    w.__lodWalk = { frames: [], active: true, last: undefined };
    const frame = (now) => {
      const s = w.__lodWalk;
      if (!s.active) return;
      if (s.last !== undefined) s.frames.push(now - s.last);
      s.last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return w.__SU_DEBUG__.snapshot().authoritative.position;
  })()`);
  const route: Array<{ x: number; y: number; z: number }> = [];
  try {
    for (let repeat = 0; repeat < 3; repeat++)
      for (const key of ['w', 'd', 's', 'a']) {
        await page.locator('#world').focus();
        await page.keyboard.down(key);
        try {
          await page.waitForTimeout(2500);
        } finally {
          await page.keyboard.up(key);
        }
        route.push(
          await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot().authoritative.position),
        );
      }
  } finally {
    await page.evaluate(() => ((window as any).__lodWalk.active = false));
  }
  const frames: number[] = await page.evaluate(() => (window as any).__lodWalk.frames);
  const sorted = frames.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  assert.ok(sorted.length > 10, 'a complete walk must have frame samples');
  assert.ok(
    route.some((p) => Math.hypot(p.x - origin.x, p.z - origin.z) > 0.15),
    'the authoritative player moved',
  );
  return { origin, route, frames, p95: sorted[Math.floor((sorted.length - 1) * 0.95)] };
}

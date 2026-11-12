import type { Page } from 'playwright';

/**
 * The in-world HUD is hidden: menu buttons live in the help panel. Opens it when needed, clicks
 * the control and closes the panel again so tests keep the same view of the world.
 */
export async function hudClick(page: Page, selector: string): Promise<void> {
  const panel = page.locator('#help-panel');
  if (!(await panel.isVisible())) await page.locator('#help-toggle').click();
  await page.locator(selector).click();
  if (await panel.isVisible()) await page.locator('#help-close').click();
}

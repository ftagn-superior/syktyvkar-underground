import type { Page } from 'playwright';

/**
 * Chat, reactions, animations, view and backpack are always on screen. Respawn, leave,
 * diagnostics and settings live in the help panel: it is opened first for those. The
 * application's panel coordinator closes help when another game panel opens.
 */
export async function hudClick(page: Page, selector: string): Promise<void> {
  const panel = page.locator('#help-panel');
  if ((await panel.locator(selector).count()) && !(await panel.isVisible()))
    await page.locator('#help-toggle').click();
  await page.locator(selector).click();
}

/** Changes quality through the settings panel and returns focus to the game. */
export async function setRenderQuality(page: Page, quality: string): Promise<void> {
  if (!(await page.locator('#help-panel').isVisible())) await page.locator('#help-toggle').click();
  await page.locator('#quality').selectOption(quality);
  await page.locator('#help-close').click();
}

/** Expands the chat field unless it is already open. */
export async function openChat(page: Page): Promise<void> {
  if (!(await page.locator('#chat-console').isVisible())) await hudClick(page, '#chat-toggle');
}

/**
 * The chat field stays open after sending: an accepted message clears it. Waits for that, then
 * collapses the field with Escape.
 */
export async function chatSent(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (document.getElementById('chat-input') as HTMLInputElement).value === '',
  );
  await page.keyboard.press('Escape');
  await page.locator('#chat-console').waitFor({ state: 'hidden' });
}

// A panel may disappear or be replaced while Playwright waits for stability.
// Re-resolve once after a timeout; never force a click or acknowledge an open UI.
export async function closePanel(panel, button, timeout) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!await panel.isVisible()) return;
    try {
      await button.click({ timeout });
      await panel.waitFor({ state: 'hidden', timeout });
      return;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      if (!await panel.isVisible()) return;
      if (attempt === 1) throw error;
    }
  }
}

/**
 * Copies text as given, through the desktop bridge first and then the browser
 * clipboard. Returns false when neither path wrote it.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof window !== "undefined" && window.ade?.app?.writeClipboardText) {
      await window.ade.app.writeClipboardText(text);
      return true;
    }
  } catch {
    // Fall back to the browser clipboard API below.
  }

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // The caller decides what a failed copy means.
  }
  return false;
}

export async function copyLaunchPromptToClipboard(promptText: string): Promise<void> {
  // Clipboard recovery is best-effort; never block the launch.
  await copyTextToClipboard(promptText.trim());
}

export async function copyLaunchPromptToClipboard(promptText: string): Promise<void> {
  const text = promptText.trim();
  if (!text) return;

  try {
    if (typeof window !== "undefined" && window.ade?.app?.writeClipboardText) {
      await window.ade.app.writeClipboardText(text);
      return;
    }
  } catch {
    // Fall back to the browser clipboard API below.
  }

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // Clipboard recovery is best-effort; never block the launch.
  }
}

/**
 * Clipboard and IPC-error helpers shared by the History surfaces: a copied SHA
 * or branch name, and the user-facing half of an IPC error.
 */

/** Resolves only when a clipboard write succeeded; rejects when neither path did. */
export async function copyText(text: string): Promise<void> {
  try {
    await window.ade.app.writeClipboardText(text);
    return;
  } catch {
    // Fall through to the browser clipboard.
  }
  if (!navigator.clipboard) throw new Error("Clipboard unavailable");
  await navigator.clipboard.writeText(text);
}

/** Drops Electron's "Error invoking remote method 'x':" prefix. */
export function stripIpcErrorPrefix(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim();
}

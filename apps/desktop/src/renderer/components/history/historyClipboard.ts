/**
 * Clipboard and IPC-error helpers shared by the History surfaces: a copied SHA
 * or branch name, and the user-facing half of an IPC error.
 */

export function copyText(text: string): void {
  void window.ade.app.writeClipboardText(text).catch(() => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  });
}

/** Drops Electron's "Error invoking remote method 'x':" prefix. */
export function stripIpcErrorPrefix(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim();
}

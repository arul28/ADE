const STORAGE_KEY = "ade.files.workbenchV2";

/**
 * Whether the v2 Files workbench (VSCode-like shell) is enabled. Defaults to OFF
 * so the shipped tab is unchanged; flip it per-machine from devtools with:
 *   localStorage.setItem("ade.files.workbenchV2", "1"); location.reload();
 * Phase 9 of the rollout flips the default to ON after the parity checklist passes.
 */
export function isFilesWorkbenchV2Enabled(): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1") {
      return true;
    }
  } catch {
    // localStorage unavailable (SSR/sandbox) — fall through to default
  }
  return false;
}

export function setFilesWorkbenchV2Enabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

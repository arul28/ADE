import { START_ON_LAST_MACHINE_STORAGE_KEY } from "../../state/useRepositoryCopies";

/**
 * Remembers the machine this client last started work on in a repository tab,
 * so "Start on" offers it first next time. Called after a chat starts.
 * `localStorage` only: a per-client convenience that may come back empty.
 */
export function recordStartOnLastMachine(tabId: string | null, machineKey: string | null): void {
  if (!tabId || !machineKey) return;
  try {
    const raw = window.localStorage.getItem(START_ON_LAST_MACHINE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const next: Record<string, string> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, string>) }
      : {};
    if (next[tabId] === machineKey) return;
    next[tabId] = machineKey;
    window.localStorage.setItem(START_ON_LAST_MACHINE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: "Start on" keeps its other order.
  }
}

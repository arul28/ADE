const LAUNCH_TRACKED_KEY = "ade.terminals.launchTracked";

export function readLaunchTracked(): boolean {
  try {
    const raw = window.localStorage.getItem(LAUNCH_TRACKED_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    // Ignore localStorage failures and keep the default tracked mode.
  }
  return true;
}

export function persistLaunchTracked(value: boolean) {
  try {
    window.localStorage.setItem(LAUNCH_TRACKED_KEY, value ? "1" : "0");
  } catch {
    // Ignore localStorage failures.
  }
}

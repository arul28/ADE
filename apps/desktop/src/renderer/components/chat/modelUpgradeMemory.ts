import type { ModelUpgrade } from "../../../shared/modelSuccessors";

/**
 * Newer-version suggestions the person turned down (ADE-300), per client like
 * the remembered model they are about. One entry per pair: closing "Fable 5.2
 * is out" on Fable 5.1 hides that pair everywhere, and a later Fable 5.3 is
 * offered again. Picking the older version by hand turns its pair down too.
 */
const DISMISSED_KEY = "ade.chat.dismissedModelUpgrades.v1";
const DISMISSED_MAX = 64;

let dismissed: string[] | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  // Another window turned one down.
  window.addEventListener("storage", (event) => {
    if (event.key !== DISMISSED_KEY && event.key !== null) return;
    dismissed = null;
    notify();
  });
}

function pairKey(upgrade: Pick<ModelUpgrade, "fromModelId" | "toModelId">): string {
  return `${upgrade.fromModelId}>${upgrade.toModelId}`;
}

function readDismissed(): string[] {
  if (dismissed) return dismissed;
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    dismissed = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    dismissed = [];
  }
  return dismissed;
}

export function isModelUpgradeDismissed(upgrade: ModelUpgrade): boolean {
  return readDismissed().includes(pairKey(upgrade));
}

export function dismissModelUpgrade(upgrade: ModelUpgrade): void {
  const key = pairKey(upgrade);
  if (readDismissed()[0] === key) return;
  dismissed = [key, ...readDismissed().filter((entry) => entry !== key)].slice(0, DISMISSED_MAX);
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  } catch {
    // Storage refused: the choice holds for this window's life.
  }
  notify();
}

export function subscribeModelUpgradeDismissals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function modelUpgradeDismissalsVersion(): number {
  return version;
}

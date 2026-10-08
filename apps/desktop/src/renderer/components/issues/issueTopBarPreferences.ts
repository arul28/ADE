import { useSyncExternalStore } from "react";

/**
 * Whether the Linear and GitHub Issues buttons show in the top bar.
 *
 * Desktop-only, this machine's choice, like the usage control beside them: the
 * phone's Work ⋯ menu always lists both. Hiding a button does not disconnect
 * anything; issue links still open in the Issues tab and the issue sheet.
 * Turning Linear off entirely is signing out of it.
 */
export type IssueTopBarPreferences = {
  linear: boolean;
  github: boolean;
};

const STORAGE_KEY = "ade.issueTopBarPreferences";
const CHANGE_EVENT = "ade:issue-top-bar-preferences-changed";
const DEFAULTS: IssueTopBarPreferences = { linear: true, github: true };

function read(): IssueTopBarPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<IssueTopBarPreferences>;
    return { linear: saved.linear !== false, github: saved.github !== false };
  } catch {
    return DEFAULTS;
  }
}

let current = typeof window === "undefined" ? DEFAULTS : read();

function emit(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      current = read();
      emit();
    }
  });
}

export function setIssueTopBarVisible(provider: keyof IssueTopBarPreferences, visible: boolean): void {
  current = { ...current, [provider]: visible };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // The choice still applies for this session.
  }
  emit();
}

export function useIssueTopBarPreferences(): IssueTopBarPreferences {
  return useSyncExternalStore(
    (subscriber) => {
      window.addEventListener(CHANGE_EVENT, subscriber);
      return () => window.removeEventListener(CHANGE_EVENT, subscriber);
    },
    () => current,
    () => DEFAULTS,
  );
}

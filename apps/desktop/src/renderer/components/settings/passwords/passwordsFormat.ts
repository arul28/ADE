/** How Settings › Passwords & Secrets words things: scopes, counts, items and errors. */
import { PASSWORDS_PERSON_CHECK_DECLINED, type PasswordItemSummary, type PasswordsProject } from "../../../../shared/types/passwords";
import { ipcErrorMessage } from "../../../lib/format";

/** "Every project", or one project, as the person reads it. */
export function scopeLabel(scope: string | null, projects: readonly PasswordsProject[]): string {
  if (scope === null) return "Every project";
  const known = projects.find((project) => project.scope === scope);
  if (known) return known.name;
  if (scope.startsWith("repo:")) return scope.slice("repo:".length).replace(/^[^/]+\//, "");
  if (scope.startsWith("path:")) return scope.split(/[\\/]/).filter(Boolean).pop() ?? scope;
  return scope;
}

/** "1 login", "3 secrets". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A login row's second line: passkey or not, username, sites. */
export function loginHint(item: PasswordItemSummary): string {
  const parts = [item.kind === "passkey" ? "Passkey" : null, item.username, item.sites.join(", ")].filter((part): part is string => Boolean(part));
  return parts.join(" · ") || "No username";
}

/** A failed call's message, or `fallback` when it has none. */
export function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

/** The person said no to Touch ID / Windows Hello: not a failure to show. */
export function personCheckDeclined(error: unknown): boolean {
  return ipcErrorMessage(error) === PASSWORDS_PERSON_CHECK_DECLINED;
}

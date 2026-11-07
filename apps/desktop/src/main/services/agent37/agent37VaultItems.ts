/**
 * The account vault items Agent 37 keeps, and the part of the vault a brain
 * opens with no project (`accountVault.call`): desktop main's Agent 37 code in
 * a window with no project on this computer (registerAgent37Ipc.ts). Any other
 * item, and any other operation, still needs a project's `account_vault`.
 *
 * Every item is scope `all`, kind `integration`.
 */
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { AGENT37_CLOUD_SIGN_INS } from "../../../shared/agent37CloudSignIns";
import { agent37CloudSignInVaultKey } from "./agent37CloudSignInStore";
import { AGENT37_VAULT_KEY, AGENT37_VAULT_KIND } from "./agent37Credential";
import { AGENT37_READY_VAULT_KEY } from "./agent37ReadySettings";
import { AGENT37_BUDGET_VAULT_KEY } from "./agent37Sleep";

/** The template build in flight, so every computer on the account sees it. */
export const AGENT37_TEMPLATE_BUILD_VAULT_KEY = "agent37-template-build";

/** What desktop main writes itself: the workspace key, the cap and limits, ready machines, the template build. */
const DESKTOP_ITEMS: ReadonlySet<string> = new Set([
  AGENT37_VAULT_KEY,
  AGENT37_BUDGET_VAULT_KEY,
  AGENT37_READY_VAULT_KEY,
  AGENT37_TEMPLATE_BUILD_VAULT_KEY,
]);

/** The sign-ins a new machine starts with: desktop main only reads them; the brain saves them. */
const SIGN_IN_ITEMS: ReadonlySet<string> = new Set(AGENT37_CLOUD_SIGN_INS.map((spec) => agent37CloudSignInVaultKey(spec.id)));

function allows(action: string, [scope, kind, key]: unknown[]): boolean {
  if (scope !== ACCOUNT_SCOPE_ALL || kind !== AGENT37_VAULT_KIND || typeof key !== "string") return false;
  if (DESKTOP_ITEMS.has(key)) return action === "get" || action === "set" || action === "remove";
  return action === "get" && SIGN_IN_ITEMS.has(key);
}

/** `service` (the `account_vault` domain) reduced to Agent 37's items; null stays null. */
export function agent37OnlyVaultService(service: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!service) return null;
  const only = (action: "get" | "set" | "remove") => (...args: unknown[]): unknown => {
    if (!allows(action, args)) {
      throw new Error(`With no project, account_vault.${action} reaches only the Agent 37 items Settings uses, as it uses them.`);
    }
    return (service[action] as (...callArgs: unknown[]) => unknown)(...args);
  };
  return { get: only("get"), set: only("set"), remove: only("remove") };
}

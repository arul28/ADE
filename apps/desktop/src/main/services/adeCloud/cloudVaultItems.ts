/**
 * The account vault items ADE Cloud keeps, and the part of the vault a brain
 * opens with no project (`accountVault.call`): desktop main's ADE Cloud code in
 * a window with no project on this computer (registerCloudIpc.ts). Any other
 * item, and any other operation, still needs a project's `account_vault`.
 *
 * Every item is scope `all`, kind `integration`.
 */
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { CLOUD_SIGN_INS } from "../../../shared/cloudSignIns";
import { cloudSignInVaultKey } from "./cloudSignInStore";
import { CLOUD_VAULT_KIND } from "./cloudAccess";
import { CLOUD_AGENT_LIMITS_VAULT_KEY } from "./cloudSleep";

/** What desktop main writes itself: agent limits. */
const DESKTOP_ITEMS: ReadonlySet<string> = new Set([
  CLOUD_AGENT_LIMITS_VAULT_KEY,
]);

/** The sign-ins a new machine starts with: desktop main only reads them; the brain saves them. */
const SIGN_IN_ITEMS: ReadonlySet<string> = new Set(CLOUD_SIGN_INS.map((spec) => cloudSignInVaultKey(spec.id)));

function allows(action: string, [scope, kind, key]: unknown[]): boolean {
  if (scope !== ACCOUNT_SCOPE_ALL || kind !== CLOUD_VAULT_KIND || typeof key !== "string") return false;
  if (DESKTOP_ITEMS.has(key)) return action === "get" || action === "set" || action === "remove";
  return action === "get" && SIGN_IN_ITEMS.has(key);
}

/** `service` (the `account_vault` domain) reduced to the provider's items; null stays null. */
export function cloudOnlyVaultService(service: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!service) return null;
  const only = (action: "get" | "set" | "remove") => (...args: unknown[]): unknown => {
    if (!allows(action, args)) {
      throw new Error(`With no project, account_vault.${action} reaches only the ADE Cloud items Settings uses, as it uses them.`);
    }
    return (service[action] as (...callArgs: unknown[]) => unknown)(...args);
  };
  return { get: only("get"), set: only("set"), remove: only("remove") };
}

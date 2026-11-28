/**
 * The account vault items ADE Cloud keeps, and the part of the vault a brain
 * opens with no project (`accountVault.call`): desktop main's ADE Cloud code in
 * a window with no project on this computer (registerCloudIpc.ts). Any other
 * item, apart from MCP server credentials, still needs a project's `account_vault`.
 *
 * ADE Cloud items use scope `all` and kind `integration`.
 */
import { MCP_SECRET_VAULT_KIND, isValidMcpFieldName, isValidMcpRegistryName } from "../../../shared/mcpRegistry";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { CLOUD_SIGN_INS, cloudSignInVaultKey } from "../../../shared/cloudSignIns";
import { CLOUD_VAULT_KIND } from "./cloudAccess";
import { CLOUD_AGENT_LIMITS_VAULT_KEY } from "./cloudSleep";
import { BRAND } from "../../../shared/brand";

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

function isMcpRegistryItem(scope: unknown, kind: unknown, key: unknown): boolean {
  if (scope !== ACCOUNT_SCOPE_ALL || kind !== MCP_SECRET_VAULT_KIND || typeof key !== "string") return false;
  const [prefix, server, field, name, extra] = key.split("/");
  return prefix === "mcp" && extra === undefined && isValidMcpRegistryName(server ?? "")
    && ((field === "oauth" && name === "token")
      || ((field === "env" || field === "header") && isValidMcpFieldName(name ?? "")));
}

/** The projectless desktop vault, limited to the settings surfaces that use it. */
export function desktopMachineVaultService(service: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!service) return null;
  const only = (action: "get" | "set" | "remove") => (...args: unknown[]): unknown => {
    if (!allows(action, args) && !isMcpRegistryItem(args[0], args[1], args[2])) {
      throw new Error(`With no project, account_vault.${action} reaches only the ${BRAND.CLOUD_NAME} items Settings uses and MCP server credentials.`);
    }
    return (service[action] as (...callArgs: unknown[]) => unknown)(...args);
  };
  return {
    get: only("get"),
    set: only("set"),
    remove: only("remove"),
    // MCP renewal confirms the refresh owner against a fresh vault. Sync
    // returns only its status and keeps the read and write filters below.
    sync: service.sync,
    list: (scope?: unknown) => {
      if (scope !== ACCOUNT_SCOPE_ALL) throw new Error("Choose the account scope to list MCP server credentials.");
      const list = service.list as (scope: string) => Array<{ scope: string; kind: string; key: string }>;
      return list(scope).filter((item) => isMcpRegistryItem(item.scope, item.kind, item.key));
    },
  };
}

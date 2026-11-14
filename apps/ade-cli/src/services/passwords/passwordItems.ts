/** Small rules about one saved item: its id, its summary, and checks on its fields. */
import crypto from "node:crypto";
import type { PasswordItemSecret, PasswordItemSummary, PasswordLoginSecret } from "../../../../desktop/src/shared/types/passwords";
import { normalizeLoginOrigin } from "./passwordMatching";
import { normalizeTotpInput } from "./passwordTotp";

/** Random bytes in a new item id, account or this-computer-only. */
export const ITEM_ID_BYTES = 12;

/** A new account item's id; the relay takes 8 to 64 of A-Z, a-z, 0-9, _ and -. */
export function newPasswordItemId(): string {
  return `pw_${crypto.randomBytes(ITEM_ID_BYTES).toString("base64url")}`;
}

/** An authenticator key as a standard otpauth:// URI, null for none; throws for one ADE cannot read. */
export function totpOrThrow(value: string | null, label: string): string | null {
  if (value === null || !value.trim()) return null;
  const normalized = normalizeTotpInput(value, label);
  if (!normalized) throw new Error("That authenticator key isn't one ADE can read. Paste the otpauth:// link or the key the site shows.");
  return normalized;
}

/** Whether a login was saved for this page's exact origin (scheme, host and port). */
export function savedForExactOrigin(secret: PasswordLoginSecret, pageUrl: string): boolean {
  const page = normalizeLoginOrigin(pageUrl)?.origin;
  return Boolean(page) && secret.origins.includes(page!);
}

/** What anyone may see of an item, agents included: never a value. */
export function summarizePasswordItem(id: string, secret: PasswordItemSecret, deviceOnly = false): PasswordItemSummary {
  if (secret.kind === "login") {
    const sites = [...new Set(secret.origins.map((origin) => normalizeLoginOrigin(origin)?.site).filter((site): site is string => Boolean(site)))];
    return {
      id,
      kind: "login",
      title: secret.title || sites[0] || "Login",
      sites,
      username: secret.username || null,
      hasPassword: Boolean(secret.password),
      hasTotp: Boolean(secret.totpUri),
      projectScope: null,
      deviceOnly: false,
      updatedAt: secret.updatedAt,
    };
  }
  if (secret.kind === "passkey") {
    const site = normalizeLoginOrigin(`https://${secret.rpId}`)?.site ?? secret.rpId;
    return {
      id,
      kind: "passkey",
      title: site,
      sites: [site],
      username: secret.userName || secret.userDisplayName || null,
      hasPassword: false,
      hasTotp: false,
      projectScope: null,
      deviceOnly: false,
      updatedAt: secret.updatedAt,
    };
  }
  return {
    id,
    kind: "secret",
    title: secret.name,
    sites: [],
    username: null,
    hasPassword: Boolean(secret.value),
    hasTotp: false,
    projectScope: secret.projectScope,
    deviceOnly,
    updatedAt: secret.updatedAt,
  };
}

/**
 * Names DAEX made up before the rename, shown with the new name.
 *
 * Machines, devices and cloud computers keep the default name they were given
 * when they were made ("ADE Cloud computer", "ADE CLI on <host>"). Those rows
 * are never migrated: other code compares them, and older clients read them.
 * Instead, a screen passes a stored name through `displayLegacyDefaultName`,
 * which swaps the product name in the exact defaults only. Anything else,
 * including every name a person typed, comes back unchanged.
 *
 * The iOS copy is `displayLegacyDefaultName` in apps/ios/ADE/Shared/LegacyDefaultNames.swift.
 */

import { BRAND } from "./brand";

const OLD = BRAND.FORMER_NAME;

const LEGACY_DEFAULTS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  // A cloud computer made with no lane name (`CLOUD_MACHINE_DEFAULT_NAME`), maybe numbered.
  [new RegExp(`^${OLD} Cloud computer((?: \\d+)?)$`), (m) => `${BRAND.CLOUD_NAME} computer${m[1]}`],
  // A cloud computer's row label, "ADE Cloud · <lane>".
  [new RegExp(`^${OLD} Cloud · (.+)$`), (m) => `${BRAND.CLOUD_NAME} · ${m[1]}`],
  // The account server's fallback computer names.
  [new RegExp(`^${OLD} computer((?: copy)?)$`), (m) => `${BRAND.NAME} computer${m[1]}`],
  // Account devices the CLI, the agent bridge and the desktop register.
  [new RegExp(`^${OLD} (CLI|agents|Desktop) on (.+)$`), (m) => `${BRAND.NAME} ${m[1]} on ${m[2]}`],
];

/** A stored name with an old default's product name swapped for DAEX; any other name unchanged. */
export function displayLegacyDefaultName(name: string): string;
export function displayLegacyDefaultName(name: string | null | undefined): string | null | undefined;
export function displayLegacyDefaultName(name: string | null | undefined): string | null | undefined {
  if (!name || !name.startsWith(OLD)) return name;
  for (const [pattern, rename] of LEGACY_DEFAULTS) {
    const match = pattern.exec(name);
    if (match) return rename(match);
  }
  return name;
}

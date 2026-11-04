/**
 * The argument readers a device action domain (`mac_desktop`,
 * `android_emulator`) uses on the action bus's `unknown` args.
 *
 * Every refusal names the domain, in the `domain.action requires key.` or
 * `domain: key must be …` shape the CLI shows as it is. Pure, with no imports,
 * so a domain module stays free of the registry.
 */

export function createDomainArgReaders(domain: string) {
  const objectArgs = (args: unknown): Record<string, unknown> =>
    args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};

  /** A trimmed string, or null for a missing, empty or non-string value. */
  const optionalString = (args: unknown, key: string): string | null => {
    const value = objectArgs(args)[key];
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length ? trimmed : null;
  };

  const requiredString = (args: unknown, key: string, action: string): string => {
    const value = optionalString(args, key);
    if (!value) throw new Error(`${domain}.${action} requires ${key}.`);
    return value;
  };

  /** A number or a numeric string; null for a missing or empty value. */
  const optionalNumber = (args: unknown, key: string): number | null => {
    const value = objectArgs(args)[key];
    if (value == null || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${domain}: ${key} must be a number.`);
    return parsed;
  };

  const requiredNumber = (args: unknown, key: string, action: string): number => {
    const value = optionalNumber(args, key);
    if (value == null) throw new Error(`${domain}.${action} requires ${key}.`);
    return value;
  };

  /** A boolean or `"true"`/`"false"`; null for a missing value. */
  const optionalBoolean = (args: unknown, key: string): boolean | null => {
    const value = objectArgs(args)[key];
    if (value == null) return null;
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${domain}: ${key} must be a boolean.`);
  };

  /** `raw` as one of `valid`, or a refusal that lists the valid values. */
  const enumValue = <T extends string>(raw: unknown, key: string, valid: readonly T[], action: string): T => {
    const match = valid.find((entry) => entry === raw);
    if (!match) {
      throw new Error(`${domain}.${action}: unknown ${key} '${String(raw)}'. Valid values: ${valid.join(", ")}.`);
    }
    return match;
  };

  return {
    objectArgs,
    optionalString,
    requiredString,
    optionalNumber,
    requiredNumber,
    optionalBoolean,
    enumValue,
    requiredLaneId: (args: unknown, action: string): string => requiredString(args, "laneId", action),
    optionalLaneId: (args: unknown): string | null => optionalString(args, "laneId"),
  };
}

import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";

/**
 * What kind of Apple device a simulator IS, from the one field that knows.
 *
 * `simctl` reports a `deviceTypeIdentifier`
 * (`com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`) alongside a `name`
 * the user is free to rename. Round 2 grouped and labelled by `name`, so a
 * simulator called "ADE Repro" was an unidentifiable row in a flat list — the
 * exact complaint from the live test. Everything here reads the identifier and
 * nothing reads the name, so a rename can never hide the model.
 *
 * Pure, and deliberately in its own file: the picker, the hero card and the
 * loading card all need the same answer, and a second copy of this rule is how
 * two surfaces end up calling the same device different things.
 */

export type AppleDeviceFamilyId = "iphone" | "ipad" | "watch" | "tv" | "vision" | "other";

/** Section order in the picker. "Other" is last because it is the leftovers. */
export const APPLE_DEVICE_FAMILY_ORDER = [
  "iphone",
  "ipad",
  "watch",
  "tv",
  "vision",
  "other",
] as const satisfies readonly AppleDeviceFamilyId[];

const FAMILY_LABEL: Record<AppleDeviceFamilyId, string> = {
  iphone: "iPhone",
  ipad: "iPad",
  watch: "Apple Watch",
  tv: "Apple TV",
  vision: "Apple Vision",
  other: "Other devices",
};

/** The picker's section heading. Never "iOS Simulators". */
export function appleDeviceFamilyLabel(family: AppleDeviceFamilyId): string {
  return FAMILY_LABEL[family];
}

const IDENTIFIER_PREFIX = "com.apple.CoreSimulator.SimDeviceType.";

/** The part of the identifier after Apple's namespace, or null. */
export function appleDeviceTypeSuffix(identifier: string | null | undefined): string | null {
  if (typeof identifier !== "string") return null;
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const suffix = trimmed.startsWith(IDENTIFIER_PREFIX)
    ? trimmed.slice(IDENTIFIER_PREFIX.length)
    : trimmed;
  return suffix.length > 0 ? suffix : null;
}

/*
 * Order matters and is not alphabetical: `Apple-Vision-Pro`, `Apple-Watch-…`
 * and `Apple-TV-…` all start with the same word, and `iPad` must be tested
 * before `iPhone` would ever see it. Matching is on the identifier suffix, so
 * a device named "iPad mini for the iPhone bug" cannot reach these rules.
 */
const FAMILY_RULES: ReadonlyArray<{ family: AppleDeviceFamilyId; test: RegExp }> = [
  { family: "vision", test: /^Apple-Vision/iu },
  { family: "watch", test: /^Apple-Watch/iu },
  { family: "tv", test: /^Apple-TV/iu },
  { family: "ipad", test: /^iPad/iu },
  { family: "iphone", test: /^iPhone/iu },
];

/** The family the identifier names, or null when it names none of them. */
export function appleDeviceFamilyFromIdentifier(
  identifier: string | null | undefined,
): AppleDeviceFamilyId | null {
  const suffix = appleDeviceTypeSuffix(identifier);
  if (!suffix) return null;
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(suffix)) return rule.family;
  }
  return null;
}

/**
 * `iPhone-17-Pro` → `iPhone 17 Pro`; `iPod-touch--7th-generation-` →
 * `iPod touch (7th generation)`.
 *
 * Apple encodes a parenthesis as an EMPTY segment between two dashes, which is
 * why this walks segments rather than running a `replaceAll("-", " ")` — that
 * shortcut turns the iPod's name into "iPod touch  7th generation" with a hole
 * in the middle of it. The `13-inch` / `6.1-inch` re-join afterwards is the one
 * place a dash survives on purpose, because that is how Apple writes it.
 */
export function appleDeviceModelLabel(identifier: string | null | undefined): string | null {
  const suffix = appleDeviceTypeSuffix(identifier);
  if (!suffix) return null;
  const segments = suffix.split("-");
  let text = "";
  let open = false;
  for (const segment of segments) {
    if (segment === "") {
      // An empty segment opens the parenthetical, and the next one closes it.
      if (open) {
        text += ")";
        open = false;
      } else {
        text += " (";
        open = true;
      }
      continue;
    }
    if (text.length > 0 && !text.endsWith("(")) text += " ";
    text += segment;
  }
  if (open) text += ")";
  return text
    .replace(/(\d+(?:\.\d+)?) inch/giu, "$1-inch")
    .replace(/\s{2,}/gu, " ")
    .trim() || null;
}

export type AppleDeviceIdentity = {
  family: AppleDeviceFamilyId;
  /** `iPhone 17 Pro`, or null when the identifier is missing. */
  model: string | null;
  /** True when the user renamed it, so the model is the only clue left. */
  renamed: boolean;
};

/**
 * The one call a card makes.
 *
 * The identifier wins; the service's own `family` field is the fallback for
 * the older records that predate it, and "other" is the floor. `renamed` is a
 * plain string comparison against the model because that is exactly what the
 * user sees: a row whose name already reads "iPhone 17 Pro" does not need a
 * second line saying "iPhone 17 Pro".
 */
export function appleDeviceIdentity(
  simulator: Pick<AppleInstalledSimulator, "name" | "family" | "deviceTypeIdentifier">,
): AppleDeviceIdentity {
  const model = appleDeviceModelLabel(simulator.deviceTypeIdentifier);
  const suffix = appleDeviceTypeSuffix(simulator.deviceTypeIdentifier);
  const fromIdentifier = appleDeviceFamilyFromIdentifier(simulator.deviceTypeIdentifier);
  /*
   * An identifier that exists but matches no rule is an HONEST "other" — the
   * service's `family` field defaults to `iphone`, so trusting it for an iPod
   * touch files the iPod under iPhone and calls the grouping a lie. The
   * fallback is only for records that carry no identifier at all.
   */
  const family: AppleDeviceFamilyId = fromIdentifier
    ?? (suffix != null
      ? "other"
      : simulator.family === "ipad" || simulator.family === "watch" || simulator.family === "iphone"
        ? simulator.family
        : "other");
  const name = simulator.name.trim();
  return { family, model, renamed: model != null && name.toLowerCase() !== model.toLowerCase() };
}

/**
 * §B2's model line: `ADE Repro · iPhone 17 Pro` when the name hides the model,
 * and the bare name when it does not. Used where only ONE line is available —
 * the tooltip and the hero card's accessible name.
 */
export function appleDeviceModelLine(
  simulator: Pick<AppleInstalledSimulator, "name" | "family" | "deviceTypeIdentifier">,
): string {
  const identity = appleDeviceIdentity(simulator);
  const name = simulator.name.trim() || "Simulator";
  return identity.renamed && identity.model ? `${name} · ${identity.model}` : name;
}

/** Booted first, then by name, within one family. */
export function groupAppleSimulatorsByFamily(
  simulators: readonly AppleInstalledSimulator[],
): Array<{ family: AppleDeviceFamilyId; label: string; devices: AppleInstalledSimulator[] }> {
  const buckets = new Map<AppleDeviceFamilyId, AppleInstalledSimulator[]>();
  for (const simulator of simulators) {
    const { family } = appleDeviceIdentity(simulator);
    const list = buckets.get(family) ?? [];
    list.push(simulator);
    buckets.set(family, list);
  }
  const groups: Array<{ family: AppleDeviceFamilyId; label: string; devices: AppleInstalledSimulator[] }> = [];
  for (const family of APPLE_DEVICE_FAMILY_ORDER) {
    const devices = buckets.get(family);
    if (!devices || devices.length === 0) continue;
    devices.sort((a, b) => {
      const booted = Number(b.state === "Booted") - Number(a.state === "Booted");
      return booted !== 0 ? booted : a.name.localeCompare(b.name);
    });
    groups.push({ family, label: appleDeviceFamilyLabel(family), devices });
  }
  return groups;
}

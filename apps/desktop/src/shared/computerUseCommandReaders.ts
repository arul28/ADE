/**
 * Readers of a parsed `ade` command line that the computer-use summary and
 * its Android part share (`computerUseActionSummary.ts`,
 * `computerUseAndroid.ts`), and the verb and target shapes they both build.
 * Pure and platform-neutral. It imports nothing, so neither of those files
 * imports the other for these.
 */

/** The parts of a parsed command that the readers look at. */
export type CommandArgs = {
  /** Positional arguments after the verb. */
  positionals: readonly string[];
  flags: ReadonlyMap<string, string | true>;
};

export type VerbSpec = {
  past: string;
  progressive: string;
  infinitive: string;
  /** How the target is read when the output names no element. */
  target: "element" | "typed" | "key" | "app" | "url" | "caption" | "direction" | "file" | "page" | "none";
  /** An observation, not an action: compact rows still read well. */
  passive?: boolean;
};

export type TargetShape = {
  target: string | null;
  quoted: boolean;
  /** "up", "down", …: "Scrolled down in “Notes list”". */
  direction: string | null;
  /** A screen point, not a name: "Clicked at 412, 300". */
  point: boolean;
};

export const NUMBER = /^-?\d+(\.\d+)?$/;

/** The first of `names` the command set to a non-empty value, trimmed. */
export function flagValue(invocation: Pick<CommandArgs, "flags">, ...names: string[]): string | null {
  for (const name of names) {
    const value = invocation.flags.get(name);
    if (typeof value === "string" && value.trim().length) return value.trim();
  }
  return null;
}

export function appNameFromBundleId(bundleId: string | null): string | null {
  if (!bundleId) return null;
  const last = bundleId.split(".").pop() ?? "";
  if (!last) return null;
  const known: Record<string, string> = {
    mobilesafari: "Safari",
    preferences: "Settings",
    mobileslideshow: "Photos",
    mobilenotes: "Notes",
    mobilemail: "Mail",
    mobilecal: "Calendar",
    mobiletimer: "Clock",
    maps: "Maps",
  };
  return known[last.toLowerCase()] ?? `${last.charAt(0).toUpperCase()}${last.slice(1)}`;
}

import type { RuntimeCompatibility } from "./types.js";

/**
 * The runtime versions this SDK build is written against.
 *
 * The SDK and the runtime ship on separate cadences, and the runtime a host
 * runs may be downloaded (`channel: "latest"`) rather than pinned. So the
 * handshake compares the runtime's self-reported version with this range. A
 * runtime outside it still connects — features it lacks are feature-detected
 * and degrade with a logged line — unless the host passes
 * `requireCompatibleRuntime: true`, which refuses it with
 * `AdeError("runtime_incompatible")`.
 *
 * The lower bound is the first runtime that carries every wire change this
 * SDK uses (`updateSession.mcpServers`, attachment `type` / `hydrate`, the
 * approval-shaped Codex elicitation). The upper bound is the next major.
 */
export const SUPPORTED_RUNTIME_RANGE = ">=1.2.81 <2.0.0";

type Version = [number, number, number];

/**
 * `major.minor.patch` from a version string, ignoring any pre-release or
 * build suffix, or null when the string does not start with three numbers.
 *
 * Ignoring the suffix is deliberate: ADE tags its alpha builds
 * `1.2.81-alpha.N`, and those carry the same wire as the release they lead to.
 * Strict semver would rank them below `1.2.81` and refuse exactly the builds a
 * host tests against first.
 */
function parseVersion(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = a[index]! - b[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Whether `version` satisfies every space-separated comparator in `range`.
 *
 * Supports `>=`, `>`, `<=`, `<` and `=` (or a bare version). That is the whole
 * grammar `SUPPORTED_RUNTIME_RANGE` uses; the package stays dependency-free, so
 * this is not a general semver implementation and does not pretend to be one.
 */
function satisfies(version: Version, range: string): boolean {
  for (const clause of range.trim().split(/\s+/)) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(clause);
    if (!match) return false;
    const bound = parseVersion(match[2]!);
    if (!bound) return false;
    const delta = compare(version, bound);
    switch (match[1] ?? "=") {
      case ">=":
        if (delta < 0) return false;
        break;
      case ">":
        if (delta <= 0) return false;
        break;
      case "<=":
        if (delta > 0) return false;
        break;
      case "<":
        if (delta >= 0) return false;
        break;
      default:
        if (delta !== 0) return false;
    }
  }
  return true;
}

/**
 * Compare a runtime's reported version with a supported range.
 *
 * A dev build (`0.0.0`) and a runtime that reports no version count as
 * supported, with a `note` saying so: both are what a developer runs from a
 * source checkout, and refusing them would make `requireCompatibleRuntime`
 * unusable in development. A non-empty version that does not parse is NOT
 * supported — the SDK cannot vouch for a build it cannot place.
 */
export function checkRuntimeCompatibility(
  version: string | null | undefined,
  range: string = SUPPORTED_RUNTIME_RANGE,
): RuntimeCompatibility {
  const reported = typeof version === "string" && version.trim() ? version.trim() : null;
  if (!reported) {
    return {
      supported: true,
      range,
      version: null,
      note: "The runtime reported no version; treated as a development build.",
    };
  }
  const parsed = parseVersion(reported);
  if (parsed && parsed[0] === 0 && parsed[1] === 0 && parsed[2] === 0) {
    return {
      supported: true,
      range,
      version: reported,
      note: "Version 0.0.0 is a development build; its wire is not checked.",
    };
  }
  if (!parsed) {
    return { supported: false, range, version: reported, note: "The version could not be parsed." };
  }
  return { supported: satisfies(parsed, range), range, version: reported, note: null };
}

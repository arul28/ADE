/**
 * Per-build version computation for local Alpha/Beta channel packages.
 *
 * `package-channel.mjs` used to ship every Alpha/Beta build under the literal
 * `apps/desktop/package.json` version. Two builds off the same checkout branch
 * therefore reported the same version to the runtime compatibility gate in
 * `localRuntimeConnectionPool.ts` (`isCompatibleRuntimeVersion` treats equal
 * versions as compatible), so a fresh Alpha app reused a stale Alpha brain left
 * by an earlier build and then failed with "Domain 'mac_desktop' is unavailable
 * in this runtime". A channel version has to change with every build:
 *
 *   <newest reachable v* tag>-<channel>.<yyyymmddHHMM>
 *
 * e.g. `1.2.75-alpha.202609211035`. The numeric timestamp parts order correctly
 * in `compareRuntimeVersionStrings`, which compares prerelease identifiers
 * numerically when both are digits.
 */

/** Strips a leading `v` from a tag and returns it only when it starts a version. */
export function parseTaggedBaseVersion(tag) {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const withoutV = trimmed.replace(/^v/i, "");
  return /^\d/.test(withoutV) ? withoutV : null;
}

/**
 * Resolves the base version the stamp hangs off: the newest `v*` tag reachable
 * from HEAD when one exists, otherwise the package.json version.
 */
export function resolveChannelBaseVersion({ taggedVersion, fallbackVersion } = {}) {
  const fromTag = parseTaggedBaseVersion(taggedVersion);
  if (fromTag) return fromTag;
  const fallback = typeof fallbackVersion === "string" ? fallbackVersion.trim() : "";
  if (!fallback) {
    throw new Error("Unable to resolve a channel base version from a v* tag or package.json.");
  }
  return fallback;
}

/**
 * `yyyymmddHHMM` in UTC.
 *
 * UTC, not local wall-clock, because two builders in different time zones must
 * still produce stamps that order the same way under
 * `compareRuntimeVersionStrings`: a later build in a western time zone would
 * otherwise get a smaller number than an earlier build in an eastern one.
 */
export function formatChannelVersionStamp(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("formatChannelVersionStamp requires a valid Date.");
  }
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return [
    pad(now.getUTCFullYear(), 4),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
  ].join("");
}

/** Builds `<base>-<channel>.<yyyymmddHHMM>`; the channel must be a simple slug. */
export function computeChannelVersion({ baseVersion, channel, now = new Date() }) {
  const base = typeof baseVersion === "string" ? baseVersion.trim() : "";
  const normalizedChannel = typeof channel === "string" ? channel.trim().toLowerCase() : "";
  if (!base) throw new Error("computeChannelVersion requires a base version.");
  if (!/^[a-z][a-z0-9-]*$/.test(normalizedChannel)) {
    throw new Error(`computeChannelVersion requires a simple channel name, received: ${channel}`);
  }
  return `${base}-${normalizedChannel}.${formatChannelVersionStamp(now)}`;
}

/**
 * Resolves which code-signing identity `scripts/package-channel.mjs` uses for a
 * local Alpha/Beta macOS app bundle.
 *
 * Ad-hoc signing (`codesign --sign -`) makes the app's designated requirement
 * `cdhash H"..."`, so macOS treats every rebuild as a different app and drops
 * the TCC grants (Screen Recording, Accessibility) on each build. A self-signed
 * certificate makes the requirement the bundle identifier plus the certificate
 * leaf, which survives rebuilds. This module is pure so the precedence is
 * unit-testable; `package-channel.mjs` owns running `security`/`codesign`.
 *
 * Precedence: the `--sign` flag, then `ADE_CHANNEL_SIGN_IDENTITY`, then an
 * auto-detected certificate named exactly `ADE Local`, then ad-hoc. Developer
 * ID identities are never auto-picked: signing with one locally is slow and
 * fails with errSecInternalComponent over SSH.
 */

export const ADE_LOCAL_SIGN_IDENTITY = "ADE Local";

/**
 * Parses `security find-identity -v -p codesigning` output. Each identity is
 * one line of the form `  1) <SHA1> "<name>"`; headers, the trailing
 * `N valid identities found` line, and anything else are ignored.
 */
export function parseCodesigningIdentities(stdout) {
  if (typeof stdout !== "string") return [];
  const identities = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]+)\s+"([^"]*)"\s*$/);
    if (!match) continue;
    identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Returns `{ identity, source }`. `identity` is `null` only for ad-hoc, where
 * the caller passes `-` to codesign. `identities` is the parsed list from
 * `parseCodesigningIdentities`; strings are accepted as bare names too.
 */
export function resolveChannelSignIdentity({ flag, env, identities } = {}) {
  const fromFlag = nonEmptyString(flag);
  if (fromFlag) return { identity: fromFlag, source: "flag" };
  const fromEnv = nonEmptyString(env);
  if (fromEnv) return { identity: fromEnv, source: "env" };

  const list = Array.isArray(identities) ? identities : [];
  const auto = list.find((entry) => {
    const name = typeof entry === "string" ? entry : entry?.name;
    return name === ADE_LOCAL_SIGN_IDENTITY;
  });
  if (auto) return { identity: ADE_LOCAL_SIGN_IDENTITY, source: "auto" };

  return { identity: null, source: "adhoc" };
}

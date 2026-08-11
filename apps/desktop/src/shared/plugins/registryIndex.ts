/**
 * The plugin directory's index contract.
 *
 * ADE's directory is a static `index.json` in a public repository, rebuilt by a
 * scheduled job that crawls the `ade-plugin` GitHub topic (design decision
 * D16). That choice buys free hosting and edge caching, and it costs exactly
 * one thing: the file is assembled from third-party repositories, so every byte
 * in it is attacker-controlled. This module is the gate that runs before any of
 * it reaches a cache, a UI, or an installer.
 *
 * The rules it enforces:
 *
 * 1. **Reject the entry, never the index.** One malformed repository is a
 *    routine event in a crawled directory. It costs its own entry and nothing
 *    else — an index that fails whole would let any published plugin take the
 *    Marketplace down.
 * 2. **Ids and URLs are validated here, once.** The plugin id is the same path
 *    component `manifest.ts` guards, and a directory-supplied source URL is the
 *    argument an installer hands to `git`. Both are checked at the boundary so
 *    no downstream caller has to remember to.
 * 3. **Checksums gate Official, and only Official.** An entry marked official
 *    carries a `sha256` per version; the installer verifies it before running
 *    anything. A community entry has none, and is honestly labelled as such
 *    rather than silently treated as vouched-for.
 *
 * Pure module — no Node built-ins, no Electron — because the daemon validates
 * with it and the renderer holds the same types.
 */

import { isValidPluginAccent, isValidPluginId, isValidPluginVersion } from "./manifest";
import { bounded, finite, isRecord, oneOf } from "./parse";
import { PLUGIN_SOCKET_KINDS, PLUGIN_SURFACE_IDS, type PluginSocketKind, type PluginSurfaceId } from "./sockets";

/**
 * Ceilings. The index is fetched on a user-facing path and cached to disk, so
 * every one of these is a cost bound rather than a taste judgement: a directory
 * that grew a megabyte of readme per entry would be paid for on every cold
 * start, on every machine.
 */
export const PLUGIN_REGISTRY_LIMITS = {
  /** Refuse the whole document above this — a directory, not a data set. */
  maxBytes: 2 * 1024 * 1024,
  maxEntries: 2_000,
  maxDescriptionChars: 300,
  maxReadmeChars: 32 * 1024,
  maxAddsLines: 12,
  maxUrlChars: 512,
  /** Per entry. Enough for a long-lived plugin's release history. */
  maxChecksumVersions: 64,
  /**
   * Screenshots and clips per entry. A gallery is a preview, not a manual —
   * and every item is a URL this app will fetch, so the ceiling is a request
   * budget as much as a taste one.
   */
  maxMedia: 8,
  maxCaptionChars: 160,
} as const;

/**
 * Hex SHA-256. Accepted in either case and stored lowercased — `sha256sum` and
 * `shasum` print lowercase, PowerShell's `Get-FileHash` prints uppercase, and
 * treating one of them as a tampered digest would be a false alarm on the one
 * check that must never cry wolf.
 */
const SHA256_HEX_PATTERN = /^[a-fA-F0-9]{64}$/;

/**
 * One screenshot or clip from a plugin's own gallery.
 *
 * `kind` is closed rather than sniffed from the extension: the app renders an
 * `<img>` or a `<video>` from it, and letting the URL decide which element it
 * lands in is how a directory entry picks the tag it is rendered in.
 */
export type PluginRegistryMedia = {
  kind: "image" | "video";
  src: string;
  caption: string | null;
};

export const PLUGIN_REGISTRY_MEDIA_KINDS = ["image", "video"] as const;

/**
 * The links a plugin publishes about itself.
 *
 * A fixed set of named slots rather than a free list of label/url pairs: the
 * detail page renders these as labelled buttons, and an entry that could name
 * its own labels could put any words it liked on a control ADE drew.
 */
export type PluginRegistryLinks = {
  repository: string | null;
  homepage: string | null;
  changelog: string | null;
  license: string | null;
  docs: string | null;
};

const PLUGIN_REGISTRY_LINK_KEYS = ["repository", "homepage", "changelog", "license", "docs"] as const;

export type PluginRegistryEntry = {
  pluginId: string;
  displayName: string;
  description: string;
  author: string;
  /** The version the directory offers, not necessarily anyone's installed one. */
  version: string;
  /** Canonical repository URL — what the crawler found. */
  repo: string;
  /**
   * The installable source. Same value as {@link repo} today; kept a separate
   * field because the Marketplace reads `source` and a future entry may point
   * installs at a mirror without moving where the crawler looks.
   */
  source: string;
  /**
   * A glyph name from the app's curated set, and a hex colour to draw it in.
   *
   * Published as `iconGlyph` and `iconColor`; the older `icon` and `accent`
   * names are still read, because entries written against the first schema are
   * live in the directory today and an icon is not worth a flag day. The pair
   * is only ever a HINT — the app derives a stable glyph and colour from the
   * plugin id when neither is set, so no entry is ever iconless.
   */
  icon: string | null;
  accent: string | null;
  /**
   * A custom image tile. Rendered instead of the glyph when it loads, and
   * silently replaced by the glyph when it does not — a broken image must cost
   * the picture, never the row.
   */
  iconUrl: string | null;
  /** Screenshots and clips for the detail page's gallery. */
  media: PluginRegistryMedia[];
  /** Named links for the detail page's resources rail. */
  links: PluginRegistryLinks;
  official: boolean;
  featured: boolean;
  isTheme: boolean;
  /** Core surfaces the plugin extends. Drives the gallery's facet chips. */
  surfaces: PluginSurfaceId[];
  /** Socket kinds it fills. Facet metadata; the manifest remains authoritative. */
  sockets: PluginSocketKind[];
  /** Short "Adds:" lines for an entry that publishes no manifest. */
  adds: string[];
  /** Measured by the directory. Null when it has never measured them. */
  installs: number | null;
  stars: number | null;
  publishedAt: string | null;
  updatedAt: string | null;
  changelogUrl: string | null;
  readme: string | null;
  /**
   * `version -> sha256 hex` over the plugin's source tree. Present for official
   * entries; an empty map means the directory vouches for nothing.
   */
  checksums: Record<string, string>;
};

export type PluginRegistryIndex = {
  version: number;
  generatedAt: string | null;
  entries: PluginRegistryEntry[];
};

export type PluginRegistryParseResult = {
  index: PluginRegistryIndex | null;
  /** Fatal: the document itself was unusable. */
  errors: string[];
  /** One per dropped entry, with the reason. */
  warnings: string[];
};

/**
 * A non-negative whole number, or null.
 *
 * `finite` from `parse.ts` answers the JSON question — NaN and both infinities
 * are numbers to `typeof` and are not counts. The floor at zero and the
 * rounding are this module's own: `installs` and `stars` are the only numbers
 * the directory publishes, they are counts of things, and a crawler that
 * emitted `-1` or `3.5` for one is reporting a bug rather than a quantity.
 */
function count(value: unknown): number | null {
  const raw = finite(value);
  return raw !== null && raw >= 0 ? Math.round(raw) : null;
}

/**
 * The members of a closed list an entry claims, in the list's own order.
 *
 * Written over `oneOf` rather than `allowed.filter(a => raw.includes(a))` so a
 * non-string element is rejected by the same reader every other contract module
 * uses — `["work", 7, {}]` is now two dropped values rather than a shape the
 * `includes` happened to answer correctly. Canonical order and de-duplication
 * come from iterating `allowed`, so a directory cannot reorder the gallery's
 * facet chips by reordering its own array.
 */
function closedList<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [];
  const claimed = new Set<T>();
  for (const value of raw) {
    const match = oneOf(value, allowed);
    if (match !== null) claimed.add(match);
  }
  return allowed.filter((item) => claimed.has(item));
}

function isoDate(value: unknown): string | null {
  const raw = bounded(value, 64);
  if (!raw) return null;
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}

/**
 * A URL the app is willing to show or hand to `git`.
 *
 * `https` only, and no credentials in the authority: a directory entry is
 * third-party text, and `https://user:token@host/repo` in a source field is how
 * a crawled index would get an installer to leak or replay a credential. `http`
 * is refused outright rather than warned about — the index is public and there
 * is no case for fetching a plugin over plaintext.
 */
export function isSafeRegistryUrl(value: unknown): value is string {
  const raw = bounded(value, PLUGIN_REGISTRY_LIMITS.maxUrlChars);
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}

/**
 * Repositories ADE's own curated set lives in.
 *
 * `official` is a claim the DIRECTORY makes about itself, and this is the one
 * property of that claim a reader can check without trusting the claimant: the
 * badge means "published by ADE", so an entry wearing it while pointing
 * somewhere else is either a mistake or an attempt, and both are answered the
 * same way — the entry still lists, as a community plugin.
 *
 * This matters beyond the badge: `official` also decides whether an install is
 * refused for a missing checksum, so a forged one buys an unverified install.
 */
const OFFICIAL_REPO_HOST = "github.com";
/**
 * Both owners are live. `arul28` is where ADE publishes today; `ade-plugins`
 * is the organisation the set will move to, and it is listed now rather than
 * on the day of the move: an installed ADE reads this list from ITS OWN build,
 * so a version that has not learned the new owner would demote every official
 * plugin to community the moment the repositories moved.
 */
const OFFICIAL_REPO_PATH_PREFIXES = ["/arul28/", "/ade-plugins/"] as const;

export function isCuratedPluginRepo(repo: string): boolean {
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return false;
  }
  // Parsed rather than string-prefixed: `https://github.com/ade-plugins/../x`
  // passes a `startsWith` and resolves somewhere else entirely.
  if (url.protocol !== "https:" || url.hostname !== OFFICIAL_REPO_HOST) return false;
  return OFFICIAL_REPO_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

export function isValidPluginChecksum(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function parseChecksums(raw: unknown, drop: (reason: string) => void): Record<string, string> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    drop("checksums is not an object");
    return {};
  }
  const checksums: Record<string, string> = {};
  let kept = 0;
  for (const [version, digest] of Object.entries(raw)) {
    if (kept >= PLUGIN_REGISTRY_LIMITS.maxChecksumVersions) break;
    if (!isValidPluginVersion(version) || !isValidPluginChecksum(digest)) continue;
    checksums[version] = (digest as string).toLowerCase();
    kept += 1;
  }
  return checksums;
}

/**
 * The gallery, dropping any item the app could not safely render.
 *
 * Item-by-item rather than all-or-nothing, for the reason the whole module is
 * written that way: one screenshot moved to a URL that no longer resolves is a
 * routine event in a crawled directory, and it must cost that screenshot.
 */
function parseMedia(raw: unknown): PluginRegistryMedia[] {
  if (!Array.isArray(raw)) return [];
  const items: PluginRegistryMedia[] = [];
  for (const value of raw) {
    if (items.length >= PLUGIN_REGISTRY_LIMITS.maxMedia) break;
    if (!isRecord(value)) continue;
    const kind = oneOf(value.kind, PLUGIN_REGISTRY_MEDIA_KINDS);
    if (kind === null) continue;
    const src = bounded(value.src, PLUGIN_REGISTRY_LIMITS.maxUrlChars);
    // The same https-only rule the source URL gets. These are fetched by the
    // renderer under a CSP that only admits a handful of hosts, but the check
    // belongs here too: the CSP is a second line, not the first.
    if (!src || !isSafeRegistryUrl(src)) continue;
    items.push({
      kind,
      src,
      caption: bounded(value.caption, PLUGIN_REGISTRY_LIMITS.maxCaptionChars),
    });
  }
  return items;
}

/**
 * The named links, each one independently optional.
 *
 * `repository` falls back to the entry's own repo URL so the resources rail
 * always has somewhere to send a reader, which is the one link that is never
 * a nice-to-have.
 */
function parseLinks(raw: unknown, repo: string): PluginRegistryLinks {
  const source = isRecord(raw) ? raw : {};
  const links = {} as Record<(typeof PLUGIN_REGISTRY_LINK_KEYS)[number], string | null>;
  for (const key of PLUGIN_REGISTRY_LINK_KEYS) {
    const value = bounded(source[key], PLUGIN_REGISTRY_LIMITS.maxUrlChars);
    links[key] = value && isSafeRegistryUrl(value) ? value : null;
  }
  return { ...links, repository: links.repository ?? repo };
}

function parseStringList(raw: unknown, maxEntries: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) return [];
  const lines: string[] = [];
  for (const value of raw) {
    if (lines.length >= maxEntries) break;
    const line = bounded(value, maxChars);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Read one directory entry, or explain why it was refused.
 *
 * Identity — a valid plugin id, a valid version, a usable repository URL — is
 * required; everything else degrades field by field. An entry with no source is
 * dropped rather than shown, because a Marketplace row whose install button
 * cannot work is worse than a row that is missing.
 */
export function parsePluginRegistryEntry(
  raw: unknown,
): { entry: PluginRegistryEntry; warnings: string[] } | { reason: string } {
  if (!isRecord(raw)) return { reason: "entry is not an object" };

  const pluginId = bounded(raw.pluginId, 64) ?? bounded(raw.name, 64);
  if (!pluginId || !isValidPluginId(pluginId)) return { reason: "pluginId is missing or not a plugin id" };

  const version = bounded(raw.version, 64);
  if (!version || !isValidPluginVersion(version)) {
    return { reason: `${pluginId}: version is missing or not major.minor.patch` };
  }

  const repo = bounded(raw.repo, PLUGIN_REGISTRY_LIMITS.maxUrlChars)
    ?? bounded(raw.repository, PLUGIN_REGISTRY_LIMITS.maxUrlChars);
  if (!repo || !isSafeRegistryUrl(repo)) return { reason: `${pluginId}: repo is missing or not an https URL` };

  const sourceRaw = bounded(raw.source, PLUGIN_REGISTRY_LIMITS.maxUrlChars);
  const source = sourceRaw && isSafeRegistryUrl(sourceRaw) ? sourceRaw : repo;

  const changelogUrl = bounded(raw.changelogUrl, PLUGIN_REGISTRY_LIMITS.maxUrlChars);
  const warnings: string[] = [];
  const checksums = parseChecksums(raw.checksums, (reason) => warnings.push(`${pluginId}: ${reason}`));

  // Demotion is loud. An entry that quietly loses its badge looks the same as
  // one that never claimed it, and the difference is the whole signal.
  //
  // BOTH halves are checked, and the reason is that they are read by different
  // code: the badge and the checksum rule read `repo`, and the installer clones
  // `source`. Binding the claim to `repo` alone let an entry name a curated
  // repository, wear the badge, waive the checksum requirement on a version the
  // directory had not digested — and then install from anywhere it liked. The
  // warning names the half that failed, because "your source is off" and "your
  // repo is off" are different mistakes for whoever has to fix the entry.
  const claimsOfficial = raw.official === true;
  const curatedRepo = isCuratedPluginRepo(repo);
  const curatedSource = isCuratedPluginRepo(source);
  const official = claimsOfficial && curatedRepo && curatedSource;
  if (claimsOfficial && !official) {
    const offending = !curatedRepo ? `repo "${repo}"` : `source "${source}"`;
    warnings.push(`${pluginId}: claims official but ${offending} is outside ADE's curated repositories — listed as community`);
  }

  // `iconColor` is the published name; `accent` is what the first schema called
  // it. Read in that order so an entry that carries both is not surprised by
  // which one wins.
  const rawAccent = bounded(raw.iconColor, 32) ?? bounded(raw.accent, 32);
  if (rawAccent && !isValidPluginAccent(rawAccent)) {
    warnings.push(`${pluginId}: icon colour "${rawAccent}" is not a hex colour — ignored`);
  }

  const iconUrl = bounded(raw.iconUrl, PLUGIN_REGISTRY_LIMITS.maxUrlChars);

  const surfaces = closedList(raw.surfaces, PLUGIN_SURFACE_IDS);
  const sockets = closedList(raw.sockets, PLUGIN_SOCKET_KINDS);

  return {
    entry: {
      pluginId,
      displayName: bounded(raw.displayName, 120) ?? pluginId,
      description: bounded(raw.description, PLUGIN_REGISTRY_LIMITS.maxDescriptionChars) ?? "",
      author: bounded(raw.author, 120) ?? "Unknown",
      version,
      repo,
      source,
      icon: bounded(raw.iconGlyph, 64) ?? bounded(raw.icon, 64),
      accent: isValidPluginAccent(rawAccent) ? rawAccent : null,
      iconUrl: iconUrl && isSafeRegistryUrl(iconUrl) ? iconUrl : null,
      media: parseMedia(raw.media),
      links: parseLinks(raw.links, repo),
      official,
      featured: raw.featured === true,
      isTheme: raw.isTheme === true,
      surfaces,
      sockets,
      adds: parseStringList(raw.adds, PLUGIN_REGISTRY_LIMITS.maxAddsLines, 120),
      installs: count(raw.installs),
      stars: count(raw.stars),
      publishedAt: isoDate(raw.publishedAt),
      updatedAt: isoDate(raw.updatedAt),
      changelogUrl: changelogUrl && isSafeRegistryUrl(changelogUrl) ? changelogUrl : null,
      readme: bounded(raw.readme, PLUGIN_REGISTRY_LIMITS.maxReadmeChars),
      checksums,
    },
    warnings,
  };
}

/**
 * Validate a decoded index document.
 *
 * A document whose `version` is newer than this build's is accepted, not
 * refused: entries are parsed field by field, so a future index degrades to the
 * fields this build understands. Refusing it would make every registry change a
 * flag day across every installed ADE.
 */
export function parsePluginRegistryIndex(raw: unknown): PluginRegistryParseResult {
  const warnings: string[] = [];
  if (!isRecord(raw)) return { index: null, errors: ["index must be a JSON object"], warnings };

  const version = typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version > 0
    ? raw.version
    : null;
  if (version === null) return { index: null, errors: ["index.version must be a positive integer"], warnings };

  if (!Array.isArray(raw.entries)) return { index: null, errors: ["index.entries must be an array"], warnings };
  if (raw.entries.length > PLUGIN_REGISTRY_LIMITS.maxEntries) {
    return {
      index: null,
      errors: [`index.entries holds ${raw.entries.length} entries, above the ${PLUGIN_REGISTRY_LIMITS.maxEntries} ceiling`],
      warnings,
    };
  }

  const entries: PluginRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of raw.entries) {
    const parsed = parsePluginRegistryEntry(candidate);
    if ("reason" in parsed) {
      warnings.push(`entry dropped: ${parsed.reason}`);
      continue;
    }
    // First writer wins on a duplicate id. The alternative — last wins — lets a
    // later entry silently shadow an official one with the same id.
    if (seen.has(parsed.entry.pluginId)) {
      warnings.push(`entry dropped: duplicate pluginId "${parsed.entry.pluginId}"`);
      continue;
    }
    warnings.push(...parsed.warnings);
    seen.add(parsed.entry.pluginId);
    entries.push(parsed.entry);
  }

  return {
    index: { version, generatedAt: isoDate(raw.generatedAt), entries },
    errors: [],
    warnings,
  };
}

/** Parse index JSON text. A syntax error is fatal and reported as an error. */
export function parsePluginRegistryIndexJson(source: string): PluginRegistryParseResult {
  if (source.length > PLUGIN_REGISTRY_LIMITS.maxBytes) {
    return {
      index: null,
      errors: [`index is ${source.length} bytes, above the ${PLUGIN_REGISTRY_LIMITS.maxBytes} byte ceiling`],
      warnings: [],
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch (error) {
    return {
      index: null,
      errors: [`index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
  return parsePluginRegistryIndex(decoded);
}

/* ── Official signing ───────────────────────────────────────────────────── */

export type PluginChecksumVerdict =
  /** The directory published a digest for this version and it matched. */
  | { kind: "verified" }
  /** No digest published. Community plugins live here; not an error. */
  | { kind: "unverified"; reason: string }
  /** A digest was published and the bytes disagree. Always fatal. */
  | { kind: "mismatch"; expected: string; actual: string };

/**
 * Compare a computed digest against what the directory vouches for.
 *
 * Called by the install service after it has the plugin's bytes on disk and
 * before it runs any of them. The three verdicts are deliberately distinct:
 * "nobody vouched" and "the voucher disagrees" are different facts, and
 * collapsing them would either block every community plugin or let a tampered
 * official one through.
 */
export function verifyPluginChecksum(args: {
  entry: Pick<PluginRegistryEntry, "official" | "checksums">;
  version: string;
  /** Lowercase hex SHA-256 the installer computed over the fetched tree. */
  actual: string;
}): PluginChecksumVerdict {
  const expected = args.entry.checksums[args.version];
  if (!expected) {
    return {
      kind: "unverified",
      reason: args.entry.official
        ? `the directory publishes no checksum for version ${args.version}`
        : "community plugins are not checksummed by the directory",
    };
  }
  if (!isValidPluginChecksum(args.actual)) {
    return { kind: "mismatch", expected, actual: String(args.actual) };
  }
  return args.actual.toLowerCase() === expected
    ? { kind: "verified" }
    : { kind: "mismatch", expected, actual: args.actual.toLowerCase() };
}

/**
 * True when an entry must be checksum-verified before it may be installed.
 *
 * Official entries with a published digest are the only ones this build
 * enforces. An official entry whose version is not in the map yet (a release
 * the crawler has not indexed) installs as unverified rather than failing —
 * the digest is a tamper check on the directory's own claim, not a licence.
 */
export function requiresChecksumVerification(
  entry: Pick<PluginRegistryEntry, "official" | "checksums">,
  version: string,
): boolean {
  return entry.official && typeof entry.checksums[version] === "string";
}

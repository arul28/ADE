#!/usr/bin/env node
/**
 * Rebuild `index.json` from the `ade-plugin` GitHub topic.
 *
 * Runs in the standalone registry repository (see ../README.md), on a schedule,
 * with no dependencies beyond Node 22 — `npm install` in a scheduled job is a
 * supply-chain surface for a file that every ADE install fetches, and this
 * script needs nothing an npm package would provide.
 *
 * What it does, in order:
 *   1. searches the topic, capped;
 *   2. reads each repository's `plugin.json` and validates it;
 *   3. refuses id squatting — a repo may not claim an id `official.json` binds
 *      to a different repository;
 *   4. merges stars and download size (GitHub) and installs (the relay's public
 *      counts);
 *   5. stamps `official` / `featured` from the curated files, never from the
 *      plugin's own manifest;
 *   6. validates the assembled document against `schema/index.schema.json`;
 *   7. writes `index.json` only if the content actually changed, so a quiet week
 *      produces no commits.
 *
 * What it deliberately does NOT do is describe a plugin in prose. The install
 * modal's "Adds:" lines are product copy, and a crawler that writes them owns a
 * second, silently diverging copy of wording the app already derives from the
 * manifest. The index publishes facts — surfaces, socket kinds, theme — and the
 * app says what they mean.
 *
 * Every network answer here is third-party text. Nothing is copied into the
 * index without passing the same checks ADE applies when it reads the result
 * (apps/desktop/src/shared/plugins/registryIndex.ts in the ADE repo).
 */

import fs from "node:fs";
import path from "node:path";

import { validateAgainstSchema } from "./validateSchema.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const TOPIC = "ade-plugin";
const GITHUB_API = "https://api.github.com";
const DEFAULT_INSTALL_COUNTS_URL = "https://ade-push-relay.arulsharma1028.workers.dev/plugins/installs";

/** Ceilings, mirroring PLUGIN_REGISTRY_LIMITS on the reading side. */
const LIMITS = {
  maxRepos: 500,
  maxEntries: 2000,
  perPage: 100,
  maxManifestBytes: 256 * 1024,
  maxReadmeChars: 32 * 1024,
  maxDescriptionChars: 300,
  maxUrlChars: 512,
  maxExtraDownloads: 4,
  maxDownloadLabelChars: 60,
  maxDownloadBytes: 64 * 1024 * 1024 * 1024,
  requestTimeoutMs: 20_000,
};

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ACCENT_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SURFACE_IDS = ["work", "lanes", "files", "prs", "automations", "cto"];
const SOCKET_KINDS = [
  "toolbar-action",
  "row-badge",
  "row-menu-item",
  "detail-section",
  "empty-state",
  "filter-chip",
  "file-viewer",
  "composer-action",
];

const token = process.env.GITHUB_TOKEN?.trim() || "";
const installCountsUrl = process.env.ADE_INSTALL_COUNTS_URL?.trim() || DEFAULT_INSTALL_COUNTS_URL;
const warnings = [];

function warn(message) {
  warnings.push(message);
  console.warn(`skip: ${message}`);
}

function readJsonFile(name, fallback) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
}

async function request(url, { accept = "application/vnd.github+json", auth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs);
  try {
    const headers = { accept, "user-agent": "ade-plugins-registry-crawler" };
    if (auth && token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    return { ok: response.ok, status: response.status, response };
  } finally {
    clearTimeout(timer);
  }
}

/** Repositories carrying the topic, newest-updated first, capped. */
async function searchTopicRepositories() {
  const repositories = [];
  for (let page = 1; page <= Math.ceil(LIMITS.maxRepos / LIMITS.perPage); page += 1) {
    const url = `${GITHUB_API}/search/repositories`
      + `?q=${encodeURIComponent(`topic:${TOPIC}`)}`
      + `&sort=updated&order=desc&per_page=${LIMITS.perPage}&page=${page}`;
    const { ok, status, response } = await request(url);
    if (!ok) {
      // A failed page is not a reason to publish a shorter index: replacing a
      // full index with a truncated one would uninstall nothing but would make
      // every missing plugin look delisted. Fail the run instead.
      throw new Error(`GitHub repository search failed with HTTP ${status}`);
    }
    const body = await response.json();
    const items = Array.isArray(body.items) ? body.items : [];
    repositories.push(...items);
    if (items.length < LIMITS.perPage) break;
  }
  return repositories.slice(0, LIMITS.maxRepos);
}

async function readRepositoryFile(fullName, filePath) {
  const url = `${GITHUB_API}/repos/${fullName}/contents/${filePath}`;
  const { ok, response } = await request(url, { accept: "application/vnd.github.raw" });
  if (!ok) return null;
  const text = await response.text();
  return text.length > LIMITS.maxManifestBytes ? null : text;
}

/** Distinct-machine install counts the relay measured. Absent is not zero. */
async function readInstallCounts() {
  try {
    const { ok, status, response } = await request(installCountsUrl, {
      accept: "application/json",
      auth: false,
    });
    if (!ok) {
      warn(`install counts unavailable (HTTP ${status}); publishing without them`);
      return new Map();
    }
    const body = await response.json();
    const counts = new Map();
    for (const row of Array.isArray(body.counts) ? body.counts : []) {
      if (typeof row?.pluginId !== "string" || !PLUGIN_ID_PATTERN.test(row.pluginId)) continue;
      if (!Number.isFinite(row.installs) || row.installs < 0) continue;
      counts.set(row.pluginId, Math.round(row.installs));
    }
    return counts;
  } catch (error) {
    warn(`install counts unavailable (${error.message}); publishing without them`);
    return new Map();
  }
}

function trimmed(value, maxChars) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * An https URL, or nothing.
 *
 * The app refuses anything else at parse time, so publishing one would produce
 * an entry with a field that silently disappears on every reader — worse than
 * omitting it, because the plugin author would see it in the index and believe
 * it worked.
 */
function httpsUrl(value) {
  const raw = trimmed(value, LIMITS.maxUrlChars);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return raw;
  } catch {
    return null;
  }
}

/** The plugin's own gallery, item by item. A bad item costs itself. */
function buildMedia(value) {
  if (!Array.isArray(value)) return [];
  const media = [];
  for (const item of value) {
    if (media.length >= 8) break;
    if (!item || typeof item !== "object") continue;
    const kind = item.kind === "video" ? "video" : item.kind === "image" ? "image" : null;
    const src = httpsUrl(item.src);
    if (!kind || !src) continue;
    const caption = trimmed(item.caption, 160);
    media.push(caption ? { kind, src, caption } : { kind, src });
  }
  return media;
}

/**
 * What the plugin says it will download for itself on first use.
 *
 * Read from the plugin's own `plugin.json`, which is the only place that knows
 * — ADE's manifest parser does not model this field, and does not need to: the
 * INDEX entry is what the Marketplace reads, and the size line is a directory
 * fact rather than a runtime one. So the crawler is where it crosses over, and
 * it crosses under the same rule as everything else here: a manifest is
 * third-party text, so an item that does not survive validation is dropped and
 * the entry keeps going.
 *
 * The 64 GiB ceiling mirrors PLUGIN_REGISTRY_LIMITS.maxDownloadBytes on the
 * reading side. Publishing a figure the app will refuse would show the author a
 * field in the index that silently vanishes on every reader.
 */
function buildExtraDownloads(value) {
  if (!Array.isArray(value)) return [];
  const downloads = [];
  for (const item of value) {
    if (downloads.length >= LIMITS.maxExtraDownloads) break;
    if (!item || typeof item !== "object") continue;
    const label = trimmed(item.label, LIMITS.maxDownloadLabelChars);
    const bytes = item.bytes;
    if (!label) continue;
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > LIMITS.maxDownloadBytes) continue;
    downloads.push({ label, bytes: Math.round(bytes) });
  }
  return downloads;
}

/**
 * The named links.
 *
 * Repository and changelog are DERIVED from where the plugin was found rather
 * than read from its manifest: those two are the links a reader uses to decide
 * whether to trust the thing, and a manifest that could point them elsewhere
 * could point them at a repository it does not control.
 */
function buildLinks({ manifest, repository, repo }) {
  const declared = manifest.links && typeof manifest.links === "object" ? manifest.links : {};
  const links = { repository: repo, changelog: `${repo}/releases` };
  const homepage = httpsUrl(declared.homepage) ?? httpsUrl(repository.homepage);
  if (homepage) links.homepage = homepage;
  const docs = httpsUrl(declared.docs);
  if (docs) links.docs = docs;
  const license = httpsUrl(declared.license);
  if (license) links.license = license;
  return links;
}

/**
 * Turn a repository plus its manifest into an index entry, or explain the
 * refusal. Only the fields the index publishes are read; the manifest's own
 * `official` flag is deliberately ignored.
 */
function buildEntry({ repository, manifest, curated, stars, installs }) {
  const pluginId = trimmed(manifest.name, 64);
  if (!pluginId || !PLUGIN_ID_PATTERN.test(pluginId)) {
    return { reason: `${repository.full_name}: plugin.json name is missing or not a plugin id` };
  }
  const version = trimmed(manifest.version, 64);
  if (!version || !PLUGIN_VERSION_PATTERN.test(version)) {
    return { reason: `${repository.full_name}: plugin.json version is missing or not major.minor.patch` };
  }
  const repo = typeof repository.html_url === "string" ? repository.html_url : null;
  if (!repo || !repo.startsWith("https://")) {
    return { reason: `${repository.full_name}: repository has no https URL` };
  }

  // Id squatting. `official.json` binds an id to one repository; a different
  // repo publishing a manifest with that name is refused outright rather than
  // demoted to a community entry, because a community "graph" beside the
  // official one is exactly the confusion the binding exists to prevent.
  //
  // The lookup is a Map, not a plain-object index, and that is a security
  // property rather than a style choice: `plugins["constructor"]` on an object
  // literal resolves up the prototype chain to a truthy function, so a
  // repository publishing `{"name": "constructor"}` — a valid plugin id — would
  // be stamped `official: true` with no checksums, which installs as
  // "vouched-for by ADE, verified against nothing".
  const official = curated.official.get(pluginId) ?? null;
  if (official && typeof official.repo === "string" && official.repo !== repo) {
    return { reason: `${repository.full_name}: id "${pluginId}" is bound to ${official.repo}` };
  }

  const sockets = Array.isArray(manifest.sockets) ? manifest.sockets : [];
  const surfaces = SURFACE_IDS.filter((surface) =>
    sockets.some((socket) => socket?.surface === surface));
  const socketKinds = SOCKET_KINDS.filter((kind) =>
    sockets.some((socket) => socket?.socket === kind));
  const isTheme = Boolean(manifest.theme && typeof manifest.theme === "object");
  const accent = trimmed(manifest.accent, 32);

  const entry = {
    pluginId,
    displayName: trimmed(manifest.displayName, 120) ?? pluginId,
    description: trimmed(manifest.description, LIMITS.maxDescriptionChars)
      ?? trimmed(repository.description, LIMITS.maxDescriptionChars)
      ?? "",
    author: trimmed(repository.owner?.login, 120) ?? "Unknown",
    version,
    repo,
    changelogUrl: `${repo}/releases`,
    official: official !== null,
    featured: curated.featured.has(pluginId),
    isTheme,
    surfaces,
    sockets: socketKinds,
  };
  // `iconGlyph`/`iconColor` are the published names; `icon`/`accent` are what
  // the manifest calls them and what the first schema published. Both are
  // written for now — installed ADEs older than the rename read the old pair,
  // and an index is read by every version that ever shipped.
  const icon = trimmed(manifest.icon, 64);
  if (icon) {
    entry.iconGlyph = icon;
    entry.icon = icon;
  }
  if (accent && ACCENT_PATTERN.test(accent)) {
    entry.iconColor = accent;
    entry.accent = accent;
  }
  const iconUrl = httpsUrl(manifest.iconUrl);
  if (iconUrl) entry.iconUrl = iconUrl;
  const media = buildMedia(manifest.media);
  if (media.length > 0) entry.media = media;
  entry.links = buildLinks({ manifest, repository, repo });
  if (Number.isFinite(stars) && stars >= 0) entry.stars = Math.round(stars);
  if (Number.isFinite(installs) && installs >= 0) entry.installs = Math.round(installs);
  // Download size, from the one number GitHub gives without fetching anything:
  // `repository.size`, in KILOBYTES. It measures the packed repository — git
  // history included, release artefacts excluded — so it is an ESTIMATE of what
  // installing costs rather than the byte count of a package. That is accepted
  // deliberately: the alternative is cloning every repository in the topic on
  // every crawl to weigh it exactly, and the reader's question ("is this a few
  // hundred KB or is it enormous") is answered fine by an estimate.
  //
  // GitHub reports 0 for a repository it has not sized yet, and 0 is left OUT
  // rather than published: readers render an absent size as nothing and a
  // present one as a measurement, so a published zero would say "this weighs
  // nothing" on ADE's own page.
  const sizeKb = repository.size;
  if (Number.isFinite(sizeKb) && sizeKb > 0) {
    entry.sizeBytes = Math.min(Math.round(sizeKb * 1024), LIMITS.maxDownloadBytes);
  }
  const extraDownloads = buildExtraDownloads(manifest.extraDownloads);
  if (extraDownloads.length > 0) entry.extraDownloads = extraDownloads;
  if (typeof repository.created_at === "string") entry.publishedAt = repository.created_at;
  if (typeof repository.pushed_at === "string") entry.updatedAt = repository.pushed_at;
  const checksums = official?.checksums;
  if (checksums && typeof checksums === "object" && Object.keys(checksums).length > 0) {
    entry.checksums = checksums;
  }
  return { entry };
}

/**
 * The curated files, as lookups that cannot be reached through a prototype.
 *
 * `official.json` is hand-edited and trusted; the ids it is looked up BY come
 * from third-party manifests, which is what makes `Object.hasOwn` filtering and
 * a Map the difference between "is this id in the Official set" and "does this
 * string resolve to anything on Object.prototype".
 */
function readCuratedFiles() {
  const featuredFile = readJsonFile("featured.json", { featured: [] });
  const officialFile = readJsonFile("official.json", { plugins: {} });
  const officialRaw = officialFile.plugins && typeof officialFile.plugins === "object"
    ? officialFile.plugins
    : {};
  const official = new Map();
  for (const pluginId of Object.keys(officialRaw)) {
    if (!Object.hasOwn(officialRaw, pluginId)) continue;
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      warn(`official.json: "${pluginId}" is not a plugin id`);
      continue;
    }
    const record = officialRaw[pluginId];
    if (!record || typeof record !== "object") continue;
    official.set(pluginId, record);
  }
  const featured = new Set(
    (Array.isArray(featuredFile.featured) ? featuredFile.featured : [])
      .filter((pluginId) => typeof pluginId === "string" && PLUGIN_ID_PATTERN.test(pluginId)),
  );
  return { featured, official };
}

async function main() {
  const curated = readCuratedFiles();
  const previous = readJsonFile("index.json", null);

  const [repositories, installCounts] = await Promise.all([
    searchTopicRepositories(),
    readInstallCounts(),
  ]);
  console.log(`found ${repositories.length} repositories with topic:${TOPIC}`);

  const entries = [];
  const claimed = new Map();
  for (const repository of repositories) {
    if (entries.length >= LIMITS.maxEntries) break;
    if (repository.archived === true || repository.disabled === true) continue;
    const manifestText = await readRepositoryFile(repository.full_name, "plugin.json");
    if (!manifestText) {
      warn(`${repository.full_name}: no readable plugin.json`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      warn(`${repository.full_name}: plugin.json is not valid JSON (${error.message})`);
      continue;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      warn(`${repository.full_name}: plugin.json is not an object`);
      continue;
    }

    const built = buildEntry({
      repository,
      manifest,
      curated,
      stars: repository.stargazers_count,
      installs: installCounts.get(trimmed(manifest.name, 64) ?? ""),
    });
    if ("reason" in built) {
      warn(built.reason);
      continue;
    }
    // Search order is newest-updated first, so the first repo to claim an id
    // keeps it. Deterministic and stable across runs, which matters more than
    // any tie-break rule: a flapping owner would rewrite the index every crawl.
    const already = claimed.get(built.entry.pluginId);
    if (already) {
      warn(`${repository.full_name}: id "${built.entry.pluginId}" already claimed by ${already}`);
      continue;
    }
    claimed.set(built.entry.pluginId, repository.full_name);

    if (built.entry.official) {
      const readme = await readRepositoryFile(repository.full_name, "README.md");
      const text = trimmed(readme, LIMITS.maxReadmeChars);
      if (text) built.entry.readme = text;
    }
    entries.push(built.entry);
  }

  entries.sort((left, right) => left.pluginId.localeCompare(right.pluginId));

  const missing = [...curated.official.keys()].filter((pluginId) => !claimed.has(pluginId));
  if (missing.length > 0) {
    console.warn(`official plugins not found in the topic: ${missing.join(", ")}`);
  }

  // Compare entries only. `generatedAt` changes every run, so including it would
  // commit an identical index every schedule tick forever.
  const unchanged = previous
    && JSON.stringify(previous.entries ?? null) === JSON.stringify(entries);
  if (unchanged) {
    console.log(`index unchanged (${entries.length} entries); nothing to write`);
    return;
  }

  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };

  // The published contract, checked before anything is published against it.
  // Every install in the world fetches this file, and the enforcing parser on
  // the reading side drops what it cannot understand SILENTLY — an entry that
  // stops meeting the contract would simply vanish from the Marketplace with
  // nothing anywhere saying why. Failing the run is how that becomes visible,
  // and it costs a crawl rather than a release.
  const schema = readJsonFile(path.join("schema", "index.schema.json"), null);
  if (!schema) throw new Error("schema/index.schema.json is missing; refusing to publish an unchecked index");
  const violations = validateAgainstSchema(index, schema);
  if (violations.length > 0) {
    for (const violation of violations.slice(0, 20)) console.error(`invalid: ${violation}`);
    throw new Error(`assembled index does not match schema/index.schema.json (${violations.length} problems)`);
  }

  fs.writeFileSync(path.join(ROOT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`wrote index.json with ${entries.length} entries (${warnings.length} skipped)`);
}

await main();

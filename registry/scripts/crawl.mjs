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
 *   4. merges stars (GitHub) and installs (the relay's public counts);
 *   5. stamps `official` / `featured` from the curated files, never from the
 *      plugin's own manifest;
 *   6. writes `index.json` only if the content actually changed, so a quiet week
 *      produces no commits.
 *
 * Every network answer here is third-party text. Nothing is copied into the
 * index without passing the same checks ADE applies when it reads the result
 * (apps/desktop/src/shared/plugins/registryIndex.ts in the ADE repo).
 */

import fs from "node:fs";
import path from "node:path";

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
  maxAddsLines: 12,
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
  const official = curated.official.plugins?.[pluginId] ?? null;
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
    adds: describeAdds(manifest).slice(0, LIMITS.maxAddsLines),
  };
  const icon = trimmed(manifest.icon, 64);
  if (icon) entry.icon = icon;
  if (accent && ACCENT_PATTERN.test(accent)) entry.accent = accent;
  if (Number.isFinite(stars) && stars >= 0) entry.stars = Math.round(stars);
  if (Number.isFinite(installs) && installs >= 0) entry.installs = Math.round(installs);
  if (typeof repository.created_at === "string") entry.publishedAt = repository.created_at;
  if (typeof repository.pushed_at === "string") entry.updatedAt = repository.pushed_at;
  const checksums = official?.checksums;
  if (checksums && typeof checksums === "object" && Object.keys(checksums).length > 0) {
    entry.checksums = checksums;
  }
  return { entry };
}

/** The install modal's "Adds:" lines, counted from what the manifest declared. */
function describeAdds(manifest) {
  const lines = [];
  const surfaces = Array.isArray(manifest.surfaces) ? manifest.surfaces : [];
  for (const surface of surfaces) {
    const title = trimmed(surface?.title, 60);
    if (!title) continue;
    lines.push(surface.kind === "pane" ? `${title} pane` : `${title} tab`);
  }
  const sockets = Array.isArray(manifest.sockets) ? manifest.sockets : [];
  if (sockets.length > 0) {
    lines.push(sockets.length === 1 ? "One addition to a core tab" : `${sockets.length} additions to core tabs`);
  }
  if (Array.isArray(manifest.cli) && manifest.cli.length > 0) lines.push("Terminal commands");
  if (Array.isArray(manifest.skills) && manifest.skills.length > 0) lines.push("Agent skills");
  if (manifest.theme && typeof manifest.theme === "object") lines.push("A colour theme");
  if (manifest.collections && Object.keys(manifest.collections).length > 0) {
    const synced = Object.values(manifest.collections).some((collection) => collection?.sync === true);
    lines.push(synced ? "Stores data, and syncs it to your other devices" : "Stores data on this machine");
  }
  if (typeof manifest.entry === "string" && manifest.entry.length > 0) lines.push("Runs code on this machine");
  return lines;
}

async function main() {
  const curated = {
    featured: new Set(readJsonFile("featured.json", { featured: [] }).featured ?? []),
    official: readJsonFile("official.json", { plugins: {} }),
  };
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

  const missing = Object.keys(curated.official.plugins ?? {})
    .filter((pluginId) => !claimed.has(pluginId));
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
  fs.writeFileSync(path.join(ROOT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`wrote index.json with ${entries.length} entries (${warnings.length} skipped)`);
}

await main();

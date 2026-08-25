import fs from "node:fs";

/**
 * Detecting a project (or `~/.ade`) that lives inside a file-syncing cloud
 * folder whose contents have been evicted to the cloud.
 *
 * When ADE opens a database file that the provider has replaced with a
 * placeholder, the read fails with an errno the platform never names — on
 * macOS it is EDEADLK, which libuv surfaces as "Unknown system error -11".
 * That message is what reached users, and it says nothing about what to do.
 *
 * Two independent signals are used, and a boot is only refused when BOTH
 * agree:
 *
 *  - The file has a size but no allocated blocks. This is what a dehydrated
 *    placeholder looks like through `fs.stat` on both macOS (File Provider)
 *    and Windows (OneDrive sparse placeholders); Node exposes no access to
 *    macOS `st_flags`/`UF_DATALESS` or to Windows file attributes, so the
 *    allocation is the only attribute-free signal available.
 *  - The path sits under a known provider root.
 *
 * Requiring both is deliberate. A project inside iCloud Drive whose files are
 * materialized works fine today, and a sparse-looking file outside any cloud
 * root is far more likely to be an empty or freshly created database than an
 * evicted one. Neither signal alone is worth blocking a working setup for —
 * and when this preflight declines to fire, the open still fails safe, because
 * `classifySqliteOpenError` buckets the raw errno into the same code.
 */
export type CloudStorageProvider =
  | "icloud"
  | "onedrive"
  | "dropbox"
  | "google-drive"
  | "cloud-storage";

/**
 * Provider roots, matched on the path text alone so this stays free on every
 * platform. macOS mounts modern providers under `~/Library/CloudStorage/` and
 * iCloud Drive under `~/Library/Mobile Documents/`; Windows and Linux clients
 * use a home-relative folder named after the provider, which is all Node can
 * see there (`fs.stat` reports no file attributes, so Windows placeholder flags
 * like FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS are not reachable without a native
 * addon).
 */
const PROVIDER_PATTERNS: ReadonlyArray<{ provider: CloudStorageProvider; pattern: RegExp }> = [
  { provider: "icloud", pattern: /[\\/]Library[\\/]Mobile Documents[\\/]/i },
  { provider: "onedrive", pattern: /[\\/]OneDrive([\\/]|$)|[\\/]OneDrive[ -][^\\/]*[\\/]/i },
  { provider: "dropbox", pattern: /[\\/]Dropbox([\\/]|$)|[\\/]Dropbox[ (][^\\/]*[\\/]/i },
  { provider: "google-drive", pattern: /[\\/]Google ?Drive([\\/]|$)/i },
  { provider: "cloud-storage", pattern: /[\\/]Library[\\/]CloudStorage[\\/]/i },
];

/** The provider folder `targetPath` sits inside, or null when it is local. */
export function detectCloudStorageProvider(targetPath: string): CloudStorageProvider | null {
  if (!targetPath) return null;
  for (const { provider, pattern } of PROVIDER_PATTERNS) {
    if (pattern.test(targetPath)) return provider;
  }
  return null;
}

/**
 * A file with content but no allocated blocks. Materialized databases always
 * allocate; only placeholders (and fully sparse files) report zero.
 */
export function isDatalessFileStats(stats: Pick<fs.Stats, "size" | "blocks">): boolean {
  return stats.size > 0 && stats.blocks === 0;
}

export type CloudPlaceholderFinding = {
  path: string;
  provider: CloudStorageProvider;
};

/**
 * One `fs.statSync` on a file ADE is about to open. Returns a finding only when
 * the file is both cloud-hosted and dehydrated; a missing file (the normal
 * first-run case) and any stat failure return null, because refusing to boot on
 * an unreadable stat would be a worse failure than the one this prevents.
 */
export function detectCloudPlaceholderFile(
  filePath: string,
  deps: { statSync?: (target: string) => Pick<fs.Stats, "size" | "blocks"> } = {},
): CloudPlaceholderFinding | null {
  const provider = detectCloudStorageProvider(filePath);
  if (!provider) return null;
  const statSync = deps.statSync ?? ((target: string) => fs.statSync(target));
  let stats: Pick<fs.Stats, "size" | "blocks">;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }
  return isDatalessFileStats(stats) ? { path: filePath, provider } : null;
}

/**
 * What each provider is called on the user's own machine.
 *
 * `cloud-storage` has no name to give: `~/Library/CloudStorage/` hosts Box,
 * Egnyte and any other File Provider, including brands this build has never
 * heard of, so that one says "the cloud" rather than guessing a brand.
 */
const PROVIDER_LABELS: Record<CloudStorageProvider, string | null> = {
  icloud: "iCloud Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  "google-drive": "Google Drive",
  "cloud-storage": null,
};

/**
 * The one sentence a person needs: where the data is and what to do.
 *
 * The remedy is stated conditionally unless a provider was actually detected,
 * because the same unreadable-file failure also arrives from a failing disk or
 * a dropped network mount, and telling someone to move a folder that is
 * already local would send them chasing the wrong thing. Brand names rather
 * than "File Provider": the brand is how the folder is labelled on their
 * machine — and it is the brand that was DETECTED, never a list, because
 * naming three services a Google Drive folder is not in only reads as wrong.
 */
export function storageUnreadableRemedy(provider?: CloudStorageProvider | null): string {
  const label = provider ? PROVIDER_LABELS[provider] ?? "the cloud" : null;
  return label
    ? `The folder is stored in ${label} and isn't downloaded to this computer. Move the project to a folder on this computer, then open it again.`
    : "If the folder is in iCloud Drive, Dropbox or OneDrive, move it to a folder on this computer and open it again.";
}

export function storageUnreadableMessage(
  targetPath: string,
  provider?: CloudStorageProvider | null,
): string {
  return `ADE couldn't read this project's data at ${targetPath}. ${storageUnreadableRemedy(provider)}`;
}

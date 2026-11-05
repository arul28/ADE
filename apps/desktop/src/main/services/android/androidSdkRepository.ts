import os from "node:os";

/*
 * Google's SDK repository: the package manifests `sdkmanager` and Android
 * Studio read (`repository2-3.xml` and the system-image `sys-img2-3.xml`
 * files), parsed with Node built-ins so the guided install needs no Java.
 *
 * The manifests are plain, machine-written XML with a fixed shape, so a small
 * reader is enough. Each package keeps its own XML so the install can write the
 * `package.xml` that `sdkmanager` and the Android Gradle plugin read.
 */

const ANDROID_REPOSITORY_BASE = "https://dl.google.com/android/repository/";
const MAIN_MANIFEST = `${ANDROID_REPOSITORY_BASE}repository2-3.xml`;
/** The system-image tags the setup card offers, best first. */
const ANDROID_SETUP_IMAGE_TAGS = ["google_apis_playstore", "google_apis"] as const;
const sysImgManifestUrl = (tag: string) => `${ANDROID_REPOSITORY_BASE}sys-img/${tag}/sys-img2-3.xml`;

export type AndroidRepoHost = { os: "macosx" | "windows" | "linux"; arch: "aarch64" | "x64" };

export type AndroidRepoArchive = {
  /** Absolute download URL. */
  url: string;
  size: number;
  sha1: string;
  hostOs: string | null;
  hostArch: string | null;
};

export type AndroidRepoPackage = {
  /** The sdkmanager path (`emulator`, `system-images;android-36;google_apis_playstore;arm64-v8a`). */
  path: string;
  displayName: string;
  /** `37.3.6`. */
  revision: string;
  revisionParts: number[];
  channel: "stable" | "beta" | "dev" | "canary";
  licenseId: string | null;
  archives: AndroidRepoArchive[];
  dependencies: Array<{ path: string; minRevision: number[] | null }>;
  apiLevel: number | null;
  tag: string | null;
  abi: string | null;
  obsolete: boolean;
  /** The `<remotePackage>` element's inner XML, for `package.xml`. */
  innerXml: string;
};

export type AndroidRepoManifest = {
  packages: AndroidRepoPackage[];
  licenses: Map<string, string>;
  /** The root element's `xmlns:*` declarations, so a `package.xml` keeps the same prefixes. */
  namespaces: string;
};

/** The host as the manifests name it, or null when Google publishes no emulator for it. */
export function androidRepoHost(
  platform: NodeJS.Platform = process.platform,
  machine: string = typeof os.machine === "function" ? os.machine() : process.arch,
): AndroidRepoHost | null {
  const arch: AndroidRepoHost["arch"] = /^(arm64|aarch64)/iu.test(machine) ? "aarch64" : "x64";
  if (platform === "darwin") return { os: "macosx", arch };
  // Google publishes no stable emulator for Linux or Windows on Arm.
  if (platform === "linux") return arch === "x64" ? { os: "linux", arch } : null;
  if (platform === "win32") return arch === "x64" ? { os: "windows", arch } : null;
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function tagText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "u").exec(xml);
  return match ? decodeXmlText(match[1]!.trim()) : null;
}

function parseRevision(xml: string | null): number[] | null {
  if (!xml) return null;
  const parts = ["major", "minor", "micro", "preview"].map((tag) => tagText(xml, tag));
  if (parts[0] === null) return null;
  const numbers: number[] = [];
  for (const part of parts.slice(0, 3)) {
    if (part === null) break;
    numbers.push(Number(part));
  }
  return numbers.every(Number.isFinite) ? numbers : null;
}

export function compareRevisions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Parses one manifest. `baseUrl` resolves the archives' relative URLs. */
function parseAndroidRepoManifest(xml: string, baseUrl: string): AndroidRepoManifest {
  const body = xml.replace(/<!--[\s\S]*?-->/gu, "");
  const root = /<([A-Za-z][\w.-]*:)?[\w.-]+\s((?:[^>]*?\s)?xmlns[\s\S]*?)>/u.exec(body);
  const namespaces = root ? (root[2]!.match(/xmlns(?::[\w.-]+)?="[^"]*"/gu) ?? []).join(" ") : "";
  const channels = new Map<string, string>();
  for (const match of body.matchAll(/<channel id="([^"]+)">([^<]+)<\/channel>/gu)) channels.set(match[1]!, match[2]!.trim());
  const licenses = new Map<string, string>();
  for (const match of body.matchAll(/<license id="([^"]+)"[^>]*>([\s\S]*?)<\/license>/gu)) {
    licenses.set(match[1]!, decodeXmlText(match[2]!));
  }
  const packages: AndroidRepoPackage[] = [];
  for (const match of body.matchAll(/<remotePackage path="([^"]+)"([^>]*)>([\s\S]*?)<\/remotePackage>/gu)) {
    const pathId = match[1]!;
    const inner = match[3]!;
    const revisionParts = parseRevision(tagText(inner, "revision")) ?? [0];
    const channelRef = /<channelRef ref="([^"]+)"/u.exec(inner)?.[1] ?? "channel-0";
    const channelName = channels.get(channelRef) ?? "stable";
    const archives: AndroidRepoArchive[] = [];
    for (const archive of inner.matchAll(/<archive>([\s\S]*?)<\/archive>/gu)) {
      const complete = /<complete>([\s\S]*?)<\/complete>/u.exec(archive[1]!)?.[1];
      if (!complete) continue;
      const url = tagText(complete, "url");
      const size = Number(tagText(complete, "size"));
      const sha1 = /<checksum[^>]*type="sha1"[^>]*>([0-9a-f]{40})<\/checksum>/iu.exec(complete)?.[1] ?? tagText(complete, "checksum");
      if (!url || !Number.isFinite(size) || !sha1) continue;
      archives.push({
        url: new URL(url, baseUrl).toString(),
        size,
        sha1: sha1.toLowerCase(),
        hostOs: tagText(archive[1]!, "host-os"),
        hostArch: tagText(archive[1]!, "host-arch"),
      });
    }
    const dependencies: AndroidRepoPackage["dependencies"] = [];
    for (const dependency of inner.matchAll(/<dependency path="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/dependency>)/gu)) {
      dependencies.push({ path: dependency[1]!, minRevision: parseRevision(dependency[2] ? tagText(dependency[2], "min-revision") : null) });
    }
    const apiLevelText = tagText(inner, "api-level");
    const apiLevel = apiLevelText === null ? null : Number.parseFloat(apiLevelText);
    const tagBlock = /<tag>([\s\S]*?)<\/tag>/u.exec(inner)?.[1] ?? null;
    packages.push({
      path: pathId,
      displayName: tagText(inner, "display-name") ?? pathId,
      revision: revisionParts.join("."),
      revisionParts,
      channel: (["stable", "beta", "dev", "canary"].includes(channelName) ? channelName : "stable") as AndroidRepoPackage["channel"],
      licenseId: /<uses-license ref="([^"]+)"/u.exec(inner)?.[1] ?? null,
      archives,
      dependencies,
      apiLevel: apiLevel !== null && Number.isFinite(apiLevel) ? apiLevel : null,
      tag: tagBlock ? tagText(tagBlock, "id") : null,
      abi: tagText(inner, "abi"),
      obsolete: /obsolete="true"/u.test(match[2]!),
      innerXml: inner,
    });
  }
  return { packages, licenses, namespaces };
}

/**
 * The archive for this host: an exact OS and CPU match first, then one that
 * names only the OS, then one that names neither (system images and
 * cmdline-tools on Linux have no host fields).
 */
export function pickAndroidArchive(pkg: AndroidRepoPackage, host: AndroidRepoHost): AndroidRepoArchive | null {
  const fits = pkg.archives.filter((archive) => (!archive.hostOs || archive.hostOs === host.os) && (!archive.hostArch || archive.hostArch === host.arch));
  const score = (archive: AndroidRepoArchive) => (archive.hostOs ? 2 : 0) + (archive.hostArch ? 1 : 0);
  return fits.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The newest stable package with this exact path that has an archive for the host. */
export function newestStablePackage(manifest: AndroidRepoManifest, packagePath: string, host: AndroidRepoHost): AndroidRepoPackage | null {
  return manifest.packages
    .filter((pkg) => pkg.path === packagePath && pkg.channel === "stable" && !pkg.obsolete && pickAndroidArchive(pkg, host))
    .sort((a, b) => compareRevisions(b.revisionParts, a.revisionParts))[0] ?? null;
}

/**
 * The phone image the setup card offers: the newest stable API level whose
 * image runs on this host ABI and on `emulatorRevision`. Integer API levels
 * and `NN.0` only: preview letters, `-beta`, `-ext` and the 16 KB page-size
 * (`_ps16k`) builds are left to the image manager.
 */
export function pickAndroidSetupImage(
  manifests: readonly AndroidRepoManifest[],
  hostAbi: "x86_64" | "arm64-v8a",
  emulatorRevision: readonly number[] | null,
): AndroidRepoPackage | null {
  const candidates: AndroidRepoPackage[] = [];
  for (const manifest of manifests) {
    for (const pkg of manifest.packages) {
      if (pkg.channel !== "stable" || pkg.obsolete || pkg.abi !== hostAbi || pkg.archives.length === 0) continue;
      if (!pkg.tag || !(ANDROID_SETUP_IMAGE_TAGS as readonly string[]).includes(pkg.tag)) continue;
      if (!/^system-images;android-\d+(\.0)?;[a-z_]+;[\w-]+$/u.test(pkg.path)) continue;
      if (pkg.apiLevel === null) continue;
      const needsEmulator = pkg.dependencies.find((dependency) => dependency.path === "emulator")?.minRevision ?? null;
      if (needsEmulator && emulatorRevision && compareRevisions(emulatorRevision, needsEmulator) < 0) continue;
      candidates.push(pkg);
    }
  }
  const tagRank = (tag: string | null) => (ANDROID_SETUP_IMAGE_TAGS as readonly string[]).indexOf(tag ?? "");
  return candidates.sort((a, b) => (b.apiLevel! - a.apiLevel!) || (tagRank(a.tag) - tagRank(b.tag)) || compareRevisions(b.revisionParts, a.revisionParts))[0] ?? null;
}

type CachedManifest = { at: number; manifest: AndroidRepoManifest };
const manifestCache = new Map<string, CachedManifest>();
/** Manifests change a few times a month; ten minutes keeps a card's reopen cheap. */
const MANIFEST_TTL_MS = 10 * 60_000;
const MANIFEST_TIMEOUT_MS = 20_000;

export type AndroidRepoFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

async function fetchManifest(url: string, fetchImpl: AndroidRepoFetch, signal?: AbortSignal): Promise<AndroidRepoManifest> {
  const cached = manifestCache.get(url);
  if (cached && Date.now() - cached.at < MANIFEST_TTL_MS) return cached.manifest;
  const timeout = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`Google's SDK repository answered ${response.status} for ${url}.`);
  const manifest = parseAndroidRepoManifest(await response.text(), new URL(".", url).toString());
  manifestCache.set(url, { at: Date.now(), manifest });
  return manifest;
}

/** The main manifest and the phone-image manifests the setup card needs. */
export async function fetchAndroidSetupManifests(options: { fetchImpl?: AndroidRepoFetch; signal?: AbortSignal } = {}): Promise<{
  main: AndroidRepoManifest;
  images: AndroidRepoManifest[];
}> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as AndroidRepoFetch);
  const [main, ...images] = await Promise.all([
    fetchManifest(MAIN_MANIFEST, fetchImpl, options.signal),
    ...ANDROID_SETUP_IMAGE_TAGS.map((tag) => fetchManifest(sysImgManifestUrl(tag), fetchImpl, options.signal)),
  ]);
  return { main: main!, images };
}

/** The licence text for an id, from whichever manifest declares it. */
export function androidLicenseText(manifests: readonly AndroidRepoManifest[], licenseId: string): string | null {
  for (const manifest of manifests) {
    const text = manifest.licenses.get(licenseId);
    if (text) return text;
  }
  return null;
}

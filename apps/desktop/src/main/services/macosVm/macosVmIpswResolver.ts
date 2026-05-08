import type {
  MacosVmIpswHostProbe,
  MacosVmIpswManifestEntry,
  MacosVmIpswResolution,
} from "../../../shared/types";

export const MACOS_IPSW_MANIFEST_URL =
  "https://mesu.apple.com/assets/macos/com_apple_macOSIPSW/com_apple_macOSIPSW.xml";

type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string | null },
) => Promise<CommandResult>;

type FetchText = (url: string) => Promise<string>;
type FetchContentLength = (url: string) => Promise<number | null>;
type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

type Token =
  | { kind: "open"; name: string }
  | { kind: "close"; name: string }
  | { kind: "self"; name: "true" | "false" }
  | { kind: "text"; value: string };

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tokenizePlist(xml: string): Token[] {
  const tokens: Token[] = [];
  const re = /<(\/?)(dict|array|key|string|integer|real|date)(?:\s[^>]*)?>|<(true|false)\s*\/>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) != null) {
    if (match[2]) {
      tokens.push({ kind: match[1] === "/" ? "close" : "open", name: match[2] });
    } else if (match[3] === "true" || match[3] === "false") {
      tokens.push({ kind: "self", name: match[3] });
    } else if (match[4]) {
      const value = decodeXml(match[4].trim());
      if (value.length > 0) tokens.push({ kind: "text", value });
    }
  }
  return tokens;
}

function parsePlist(xml: string): PlistValue | null {
  const tokens = tokenizePlist(xml);
  let index = 0;

  const readTextUntilClose = (name: string): string => {
    const parts: string[] = [];
    while (index < tokens.length) {
      const token = tokens[index++];
      if (!token) break;
      if (token.kind === "close" && token.name === name) break;
      if (token.kind === "text") parts.push(token.value);
    }
    return parts.join("");
  };

  const parseValue = (): PlistValue | null => {
    const token = tokens[index++];
    if (!token) return null;
    if (token.kind === "self") return token.name === "true";
    if (token.kind !== "open") return null;
    switch (token.name) {
      case "dict": {
        const result: Record<string, PlistValue> = {};
        while (index < tokens.length) {
          const next = tokens[index];
          if (next?.kind === "close" && next.name === "dict") {
            index += 1;
            break;
          }
          if (next?.kind !== "open" || next.name !== "key") {
            index += 1;
            continue;
          }
          index += 1;
          const key = readTextUntilClose("key");
          const value = parseValue();
          if (key && value != null) result[key] = value;
        }
        return result;
      }
      case "array": {
        const result: PlistValue[] = [];
        while (index < tokens.length) {
          const next = tokens[index];
          if (next?.kind === "close" && next.name === "array") {
            index += 1;
            break;
          }
          const value = parseValue();
          if (value != null) result.push(value);
        }
        return result;
      }
      case "integer":
      case "real": {
        const parsed = Number(readTextUntilClose(token.name));
        return Number.isFinite(parsed) ? parsed : 0;
      }
      case "key":
      case "string":
      case "date":
        return readTextUntilClose(token.name);
      default:
        return null;
    }
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (token?.kind === "open" && token.name === "dict") return parseValue();
    index += 1;
  }
  return null;
}

function asRecord(value: PlistValue | undefined): Record<string, PlistValue> | null {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
    ? value as Record<string, PlistValue>
    : null;
}

function asString(value: PlistValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part));
  const right = b.split(".").map((part) => Number(part));
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
}

function sortManifestEntries(entries: MacosVmIpswManifestEntry[]): MacosVmIpswManifestEntry[] {
  return [...entries].sort((a, b) => {
    const versionDelta = compareVersions(b.productVersion, a.productVersion);
    if (versionDelta !== 0) return versionDelta;
    return b.build.localeCompare(a.build);
  });
}

function uniqueEntries(entries: MacosVmIpswManifestEntry[]): MacosVmIpswManifestEntry[] {
  const byKey = new Map<string, MacosVmIpswManifestEntry>();
  for (const entry of entries) {
    const key = `${entry.build}|${entry.productVersion}|${entry.firmwareUrl}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        supportedDeviceModels: [...new Set([...existing.supportedDeviceModels, ...entry.supportedDeviceModels])].sort(),
      });
    } else {
      byKey.set(key, { ...entry, supportedDeviceModels: [...entry.supportedDeviceModels].sort() });
    }
  }
  return sortManifestEntries([...byKey.values()]);
}

export function parseSoftwareUpdateList(
  output: string,
  currentBuild: string | null,
  model: string | null,
): MacosVmIpswHostProbe {
  let pendingBuild: string | null = null;
  let pendingProductVersion: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const buildMatch = line.match(/macOS[^\n]*?-([A-Z0-9]{5,})\b/i) ?? line.match(/\bBuild(?:Version)?\D+([A-Z0-9]{5,})\b/i);
    if (!buildMatch?.[1]) continue;
    const build = buildMatch[1].trim();
    if (currentBuild && build === currentBuild) continue;
    const versionMatch = line.match(/macOS[^\n]*?(\d+(?:\.\d+){1,2})/i);
    pendingBuild = build;
    pendingProductVersion = versionMatch?.[1] ?? null;
    break;
  }
  return {
    pendingBuild,
    pendingProductVersion,
    currentBuild,
    model,
  };
}

export async function probeMacosIpswHostState(runCommand: CommandRunner): Promise<MacosVmIpswHostProbe> {
  const run = async (command: string, args: string[], timeoutMs: number): Promise<string> => {
    try {
      const result = await runCommand(command, args, { timeoutMs });
      if (result.exitCode !== 0) return "";
      return result.stdout.trim();
    } catch {
      return "";
    }
  };
  const [currentBuildRaw, modelRaw, updatesRaw] = await Promise.all([
    run("sw_vers", ["-buildVersion"], 10_000),
    run("sysctl", ["-n", "hw.model"], 10_000),
    run("softwareupdate", ["-l", "--no-scan"], 60_000),
  ]);
  const currentBuild = currentBuildRaw || null;
  const model = modelRaw || null;
  return parseSoftwareUpdateList(updatesRaw, currentBuild, model);
}

export function parseMacosIpswManifest(xml: string): MacosVmIpswManifestEntry[] {
  const plist = asRecord(parsePlist(xml) ?? undefined);
  const versionsByVersion = asRecord(plist?.MobileDeviceSoftwareVersionsByVersion);
  const versionOne = asRecord(versionsByVersion?.["1"]);
  const softwareVersions = asRecord(versionOne?.MobileDeviceSoftwareVersions);
  if (!softwareVersions) return [];

  const entries: MacosVmIpswManifestEntry[] = [];
  for (const [model, modelValue] of Object.entries(softwareVersions)) {
    const modelBuilds = asRecord(modelValue);
    if (!modelBuilds) continue;
    for (const buildValue of Object.values(modelBuilds)) {
      const buildRecord = asRecord(buildValue);
      const restore = asRecord(buildRecord?.Restore) ?? asRecord(buildRecord?.Universal);
      if (!restore) continue;
      const firmwareUrl = asString(restore.FirmwareURL);
      const build = asString(restore.BuildVersion);
      const productVersion = asString(restore.ProductVersion);
      if (!firmwareUrl || !build || !productVersion) continue;
      entries.push({
        build,
        productVersion,
        firmwareUrl,
        supportedDeviceModels: [model],
        sizeBytes: null,
      });
    }
  }

  return uniqueEntries(entries);
}

export function pickMacosIpsw(
  entries: MacosVmIpswManifestEntry[],
  host: MacosVmIpswHostProbe,
): MacosVmIpswResolution | null {
  const sorted = sortManifestEntries(entries);
  const compatible = host.model
    ? sorted.filter((entry) => entry.supportedDeviceModels.includes(host.model as string))
    : sorted;
  const candidates = compatible.length > 0 ? compatible : sorted;
  if (candidates.length === 0) return null;

  const pending = host.pendingBuild
    ? candidates.find((entry) => entry.build === host.pendingBuild)
    : null;
  const current = host.currentBuild
    ? candidates.find((entry) => entry.build === host.currentBuild)
    : null;
  const selected = pending ?? current ?? candidates[0]!;
  const source = pending
    ? "pending-build"
    : current
      ? "current-build"
      : "newest-supported";

  return {
    url: selected.firmwareUrl,
    build: selected.build,
    productVersion: selected.productVersion,
    sizeBytes: selected.sizeBytes,
    source,
    supportedDeviceModels: selected.supportedDeviceModels,
    alternatives: candidates.slice(0, 20),
    host,
  };
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

async function defaultFetchContentLength(url: string): Promise<number | null> {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) return null;
  const raw = response.headers.get("content-length");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function resolveMacosIpsw(
  host: MacosVmIpswHostProbe,
  options: {
    fetchText?: FetchText;
    fetchContentLength?: FetchContentLength;
    manifestUrl?: string;
  } = {},
): Promise<MacosVmIpswResolution | null> {
  if (!host.pendingBuild && !host.currentBuild && !host.model) return null;
  const fetchText = options.fetchText ?? defaultFetchText;
  const manifestXml = await fetchText(options.manifestUrl ?? MACOS_IPSW_MANIFEST_URL);
  const entries = parseMacosIpswManifest(manifestXml);
  const picked = pickMacosIpsw(entries, host);
  if (!picked) return null;

  const fetchLength = options.fetchContentLength ?? defaultFetchContentLength;
  let sizeBytes = picked.sizeBytes;
  if (sizeBytes == null) {
    try {
      sizeBytes = await fetchLength(picked.url);
    } catch {
      sizeBytes = null;
    }
  }
  return {
    ...picked,
    sizeBytes,
    alternatives: picked.alternatives.map((entry) =>
      entry.firmwareUrl === picked.url ? { ...entry, sizeBytes } : entry,
    ),
  };
}

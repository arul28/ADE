import fs from "node:fs";
import path from "node:path";

export type ProductAnalyticsInstallSource =
  | "development"
  | "homebrew"
  | "direct_download"
  | "unknown";

type DetectInstallSourceArgs = {
  isPackaged: boolean;
  execPath: string;
  resourcesPath?: string | null;
  configuredSource?: string | null;
  homebrewPrefix?: string | null;
  realpath?: (candidate: string) => string;
  exists?: (candidate: string) => boolean;
};

function canonicalPath(
  candidate: string | null | undefined,
  realpath: (candidate: string) => string,
): string | null {
  if (!candidate) return null;
  try {
    return realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export function detectInstallSource(args: DetectInstallSourceArgs): ProductAnalyticsInstallSource {
  if (!args.isPackaged) return "development";

  const configuredSource = args.configuredSource?.trim().toLowerCase();
  if (configuredSource === "homebrew" || configuredSource === "direct_download") {
    return configuredSource;
  }

  const realpath = args.realpath ?? fs.realpathSync.native;
  const candidates = [args.execPath, args.resourcesPath]
    .flatMap((candidate) => [candidate, canonicalPath(candidate, realpath)])
    .filter((candidate): candidate is string => Boolean(candidate));
  if (candidates.some((candidate) => /(?:^|[/\\])(?:homebrew|caskroom)(?:[/\\]|$)/i.test(candidate))) {
    return "homebrew";
  }

  const homebrewPrefix = canonicalPath(args.homebrewPrefix, realpath);
  const exists = args.exists ?? fs.existsSync;
  if (homebrewPrefix && exists(path.join(homebrewPrefix, "Caskroom", "ade"))) {
    return "homebrew";
  }

  if (candidates.some((candidate) => /(?:^|[/\\])Applications[/\\]ADE(?: Beta)?\.app(?:[/\\]|$)/i.test(candidate))) {
    return "direct_download";
  }
  return "unknown";
}

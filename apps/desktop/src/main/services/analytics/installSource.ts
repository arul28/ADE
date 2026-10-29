import fs from "node:fs";
import path from "node:path";

export type ProductAnalyticsInstallSource =
  | "development"
  | "homebrew"
  | "direct_download"
  | "install_script"
  | "unknown";

type DetectInstallSourceArgs = {
  isPackaged: boolean;
  execPath: string;
  resourcesPath?: string | null;
  configuredSource?: string | null;
  /** `$APPIMAGE`: an AppImage runs from a temporary mount, so its own path is only here. */
  appImagePath?: string | null;
  realpath?: (candidate: string) => string;
  /** Homebrew casks copy the app to /Applications; their Caskroom entry is the only trace. */
  caskroomExists?: () => boolean;
};

const HOMEBREW_CASKROOM_ENTRIES = [
  "/opt/homebrew/Caskroom/ade",
  "/opt/homebrew/Caskroom/ade-beta",
  "/usr/local/Caskroom/ade",
  "/usr/local/Caskroom/ade-beta",
];

function homebrewCaskroomExists(): boolean {
  if (process.platform !== "darwin") return false;
  return HOMEBREW_CASKROOM_ENTRIES.some((entry) => {
    try {
      return fs.existsSync(entry);
    } catch {
      return false;
    }
  });
}

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
  if (
    configuredSource === "homebrew"
    || configuredSource === "direct_download"
    || configuredSource === "install_script"
  ) {
    return configuredSource;
  }

  // A brain run by a plain Node binary (npm, a source checkout) says nothing
  // about how ADE got there; a Homebrew-installed Node is not a Homebrew ADE.
  if (/^node(?:\.exe)?$/i.test(path.basename(args.execPath))) return "unknown";

  const realpath = args.realpath ?? fs.realpathSync.native;
  const candidates = [args.execPath, args.resourcesPath, args.appImagePath]
    .flatMap((candidate) => [candidate, canonicalPath(candidate, realpath)])
    .filter((candidate): candidate is string => Boolean(candidate));
  if (candidates.some((candidate) => /(?:^|[/\\])(?:homebrew|caskroom)(?:[/\\]|$)/i.test(candidate))) {
    return "homebrew";
  }

  // The brain installer (install.sh / install.ps1) puts a standalone binary in
  // <home>/.ade/bin (or .ade-beta/bin).
  if (candidates.some((candidate) => /[/\\]\.ade(?:-[a-z]+)?[/\\]bin[/\\]ade(?:\.exe)?$/i.test(candidate))) {
    return "install_script";
  }

  const insideMacApp = candidates.some((candidate) =>
    /(?:^|[/\\])Applications[/\\]ADE(?: Beta)?\.app(?:[/\\]|$)/i.test(candidate));
  if (insideMacApp) {
    return (args.caskroomExists ?? homebrewCaskroomExists)() ? "homebrew" : "direct_download";
  }
  // The Windows installer (per-user, default %LOCALAPPDATA%\Programs\ADE, but
  // the directory is choosable, so the executable name decides), and an
  // AppImage on Linux.
  if (candidates.some((candidate) => /[/\\]ADE(?: Beta)?\.exe$/i.test(candidate))) {
    return "direct_download";
  }
  if (candidates.some((candidate) => /\.AppImage$/i.test(candidate))) {
    return "direct_download";
  }
  return "unknown";
}

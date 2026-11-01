export type CliProxyApiPlatformKey =
  | "darwin-arm64"
  | "darwin-amd64"
  | "linux-amd64"
  | "linux-arm64"
  | "windows-amd64"
  | "windows-arm64";

export type CliProxyApiReleaseAsset = {
  url: string;
  sha256: string;
  archive: "tar.gz" | "zip";
  binaryName: string;
};

export type CliProxyApiRelease = {
  version: string;
  assets: Readonly<Record<CliProxyApiPlatformKey, CliProxyApiReleaseAsset>>;
};

export const version = "8.0.48" as const;

const releaseBaseUrl = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.48";

// CLIProxyAPI v8.0.48 publishes checksums.txt alongside these official assets.
export const assets = {
  "darwin-arm64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_8.0.48_darwin_aarch64.tar.gz`,
    sha256: "543bdbc6f8384fecd033bf7398236e46279962a80dbc909cf8d8e6ee94ccfc04",
    archive: "tar.gz",
    binaryName: "cli-proxy-api",
  },
  "darwin-amd64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_8.0.48_darwin_amd64.tar.gz`,
    sha256: "97f662d40bc3da1bd6bb0f9188ba803d11e0cb29dfc037376bb655bf3f437781",
    archive: "tar.gz",
    binaryName: "cli-proxy-api",
  },
  "linux-amd64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_8.0.48_linux_amd64.tar.gz`,
    sha256: "095c46e7165842cf563f9665be86cf24a29ba94e57ab9bd67588fe5cc4c7125c",
    archive: "tar.gz",
    binaryName: "cli-proxy-api",
  },
  "linux-arm64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_8.0.48_linux_aarch64.tar.gz`,
    sha256: "9ed7c06aa96d9cc6736ddfc897de07b8b6085731785087f6701f07ec9ec198dd",
    archive: "tar.gz",
    binaryName: "cli-proxy-api",
  },
  "windows-amd64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_8.0.48_windows_amd64.zip`,
    sha256: "6806d1ff586a33da9a470d4b6f119d73dd00743c5282d62e7df4d32a2a2a6aef",
    archive: "zip",
    binaryName: "cli-proxy-api.exe",
  },
  "windows-arm64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_8.0.48_windows_aarch64.zip`,
    sha256: "6f248b60e6e4d634ca4bc155e22e5392bcdca4e8eeb633f3cc9acad6766efa5e",
    archive: "zip",
    binaryName: "cli-proxy-api.exe",
  },
} satisfies Readonly<Record<CliProxyApiPlatformKey, CliProxyApiReleaseAsset>>;

export const CLI_PROXY_API_RELEASE: CliProxyApiRelease = { version, assets };
export const cliProxyApiRelease = CLI_PROXY_API_RELEASE;

export function resolvePlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CliProxyApiPlatformKey {
  const releasePlatform = platform === "darwin"
    ? "darwin"
    : platform === "linux"
      ? "linux"
      : platform === "win32"
        ? "windows"
        : null;
  if (!releasePlatform) {
    throw new Error(`CLIProxyAPI v${version} does not support platform ${platform}`);
  }

  const releaseArch = arch === "x64"
    ? "amd64"
    : arch === "arm64"
      ? "arm64"
      : null;
  if (!releaseArch) {
    throw new Error(`CLIProxyAPI v${version} does not support architecture ${arch}`);
  }

  return `${releasePlatform}-${releaseArch}` as CliProxyApiPlatformKey;
}

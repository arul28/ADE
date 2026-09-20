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

export const version = "7.3.7" as const;

const releaseBaseUrl = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.3.7";

// CLIProxyAPI v7.3.7 publishes checksums.txt alongside these official assets.
export const assets = {
  "darwin-arm64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_7.3.7_darwin_aarch64.tar.gz`,
    sha256: "15269902173e99b834b8577a520ddf8f89fbb4a224afd2230384c1890b06875f",
    archive: "tar.gz",
    binaryName: "cli-proxy-api",
  },
  "darwin-amd64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_7.3.7_darwin_amd64.tar.gz`,
    sha256: "7b20a8988afe1dff0a5f3cd3d7fd30300576d630506d747e74ce25dfc46bb2af",
    archive: "tar.gz",
    binaryName: "cli-proxy-api",
  },
  "linux-amd64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_7.3.7_linux_amd64.tar.gz`,
    sha256: "3391dff672abccffce5f9259b7ce1e12cee7b0a8aa3f5b2280406484f59f37ba",
    archive: "tar.gz",
    binaryName: "cli-proxy-api",
  },
  "linux-arm64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_7.3.7_linux_aarch64.tar.gz`,
    sha256: "442aad130260cc22a75d2b230826e0b2185e92baf5ef8ae57b849ae694dddf2a",
    archive: "tar.gz",
    binaryName: "cli-proxy-api",
  },
  "windows-amd64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_7.3.7_windows_amd64.zip`,
    sha256: "da5466b81beb7c769b99e26a5f6f41d9999a07be7c36be170167f10a2a6ecfc7",
    archive: "zip",
    binaryName: "cli-proxy-api.exe",
  },
  "windows-arm64": {
    url: `${releaseBaseUrl}/CLIProxyAPI_7.3.7_windows_aarch64.zip`,
    sha256: "e940427e0e09afe9b92b5902dc357a96581cd03bd820aaea72566b5844b493ea",
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

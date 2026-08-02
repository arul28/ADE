export function resolveWindowsPackageIdentity(rawChannel = "") {
  const rawValue = String(rawChannel ?? "").trim();
  const packageChannel = rawValue.toLowerCase() || "stable";
  if (!new Set(["stable", "beta", "alpha"]).has(packageChannel)) {
    throw new Error(`Unsupported ADE_PACKAGE_CHANNEL '${rawValue}'. Expected stable, beta, or alpha.`);
  }
  const channelLabel = packageChannel === "stable"
    ? ""
    : `${packageChannel[0].toUpperCase()}${packageChannel.slice(1)}`;
  const productName = channelLabel ? `ADE ${channelLabel}` : "ADE";
  const appId = packageChannel === "stable"
    ? "com.ade.desktop"
    : `com.ade.desktop.${packageChannel}`;
  return {
    packageChannel,
    productName,
    // Release asset names must never contain a space. electron-builder writes
    // the installer with the raw product name but rewrites latest.yml's
    // url/path to a space-free "safe" name for GitHub, and the release workflow
    // uploads the on-disk file through `gh release upload`, where GitHub
    // normalizes disallowed characters again. A space-free artifact base name
    // keeps the built file, latest.yml, and the published asset identical.
    artifactBaseName: channelLabel ? `ADE-${channelLabel}` : "ADE",
    appId,
    executableName: `${productName}.exe`,
    fileClass: `${appId}.files`,
  };
}

export function isGithubSafeAssetName(name) {
  return /^[0-9A-Za-z._-]+$/.test(String(name ?? ""));
}

export function windowsInstallerArtifactName(identity) {
  // electron-builder macros are expanded by electron-builder, not here.
  // eslint-disable-next-line no-template-curly-in-string
  return `${identity.artifactBaseName}-\${version}-win-\${arch}.\${ext}`;
}

export function windowsInstallerPattern(identity) {
  const escapedBaseName = identity.artifactBaseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The version segment always starts with a digit, so the Stable pattern can
  // never also match a channel build such as ADE-Beta-1.2.3-win-x64.exe when a
  // single release directory holds both installers.
  return new RegExp(`^${escapedBaseName}-\\d.*-win-x64\\.exe$`);
}

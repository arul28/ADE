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
    appId,
    executableName: `${productName}.exe`,
    fileClass: `${appId}.files`,
  };
}

export function windowsInstallerPattern(identity) {
  const escapedProductName = identity.productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedProductName}-.+-win-x64\\.exe$`);
}

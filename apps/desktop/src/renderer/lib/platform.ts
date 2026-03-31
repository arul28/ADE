function getPlatformValue(): string {
  if (typeof navigator !== "undefined" && typeof navigator.platform === "string") {
    return navigator.platform;
  }
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform;
  }
  return "";
}

const isMac = /mac|darwin/i.test(getPlatformValue());
export const revealLabel = isMac ? "Reveal in Finder" : "Reveal in File Explorer";

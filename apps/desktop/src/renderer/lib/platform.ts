const platformValue =
  typeof navigator !== "undefined" && typeof navigator.platform === "string"
    ? navigator.platform
    : typeof process !== "undefined" && typeof process.platform === "string"
      ? process.platform
      : "";

const isMac = platformValue.toLowerCase().includes("mac") || platformValue === "darwin";
export const revealLabel = isMac ? "Reveal in Finder" : "Reveal in File Explorer";

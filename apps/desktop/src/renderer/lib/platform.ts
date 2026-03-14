const isMac = navigator.platform.toLowerCase().includes("mac");
export const revealLabel = isMac ? "Reveal in Finder" : "Reveal in File Explorer";

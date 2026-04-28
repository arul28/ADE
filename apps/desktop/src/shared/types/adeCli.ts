export type AdeCliStatus = {
  command: "ade";
  platform: NodeJS.Platform;
  isPackaged: boolean;
  bundledAvailable: boolean;
  bundledBinDir: string | null;
  bundledCommandPath: string | null;
  installerPath: string | null;
  agentPathReady: boolean;
  terminalInstalled: boolean;
  terminalCommandPath: string | null;
  installAvailable: boolean;
  installTargetPath: string;
  installTargetDirOnPath: boolean;
  message: string;
  nextAction: string | null;
};

export type AdeCliInstallResult = {
  ok: boolean;
  message: string;
  status: AdeCliStatus;
};

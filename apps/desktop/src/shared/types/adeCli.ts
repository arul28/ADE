export type AdeCliStatus = {
  /** The installed `ade` name (`ade`, `ade-alpha`, `ade-dev`): the permanent alias. */
  command: string;
  /** The primary `daex` name installed beside it (`daex`, `daex-alpha`, `daex-dev`), when there is one. */
  aliasCommand?: string | null;
  /** Where `aliasCommand` resolves on the user's PATH, or null when it does not. */
  terminalAliasCommandPath?: string | null;
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

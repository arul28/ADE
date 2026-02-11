export type AppInfo = {
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
    v8: string;
  };
  env: {
    nodeEnv?: string;
    viteDevServerUrl?: string;
  };
};

export type ProjectInfo = {
  rootPath: string;
  displayName: string;
  baseRef: string;
};

// react-resizable-panels uses a map of panel id -> percentage (0..100)
export type DockLayout = Record<string, number>;


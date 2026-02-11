export {};

declare global {
  interface Window {
    ade: {
      app: {
        ping: () => Promise<"pong">;
        getInfo: () => Promise<{
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
        }>;
        getProject: () => Promise<{
          rootPath: string;
          displayName: string;
          baseRef: string;
        }>;
      };
      layout: {
        get: (layoutId: string) => Promise<Record<string, number> | null>;
        set: (layoutId: string, layout: Record<string, number>) => Promise<void>;
      };
    };
  }
}

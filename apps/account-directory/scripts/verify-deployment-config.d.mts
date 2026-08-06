export declare const REQUIRED_SECRETS: readonly string[];
export declare const REQUIRED_VARS: readonly string[];
export declare const ENVIRONMENTS: readonly string[];

export declare class DeploymentConfigError extends Error {}

export declare function parseJsonc(source: string): unknown;

export declare function verifyDirectoryDeploymentConfig(args: {
  listSecretNames: (environment: string) => Iterable<string>;
  readConfig: () => unknown;
}): void;

export declare function wranglerSecretListInvocation(
  environment: string,
  platform?: NodeJS.Platform,
): {
  command: string;
  args: string[];
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "inherit"];
    windowsHide: true;
    shell?: true;
  };
};

export declare function wranglerSecretNames(
  environment: string,
  overrides?: {
    platform?: NodeJS.Platform;
    exec?: (
      command: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => string;
  },
): string[];

export type DevToolStatus = {
  id: "git" | "gh";
  label: string;
  command: string;
  installed: boolean;
  detectedPath: string | null;
  detectedVersion: string | null;
  required: boolean;
};

export type DevToolsCheckResult = {
  tools: DevToolStatus[];
  platform: NodeJS.Platform;
};

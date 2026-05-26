import type { LaunchProfile } from "../../../shared/cliLaunch";
import type { PtyCreateResult } from "../../../shared/types";

export * from "../../../shared/cliLaunch";

export type WorkPtyLaunchDisposition = "foreground" | "background";

export type WorkPtyLaunchArgs = {
  laneId: string;
  profile: LaunchProfile;
  title?: string;
  startupCommand?: string;
  startupDelayMs?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tracked?: boolean;
  disposition?: WorkPtyLaunchDisposition;
};

export type WorkPtyLaunchResult = PtyCreateResult;

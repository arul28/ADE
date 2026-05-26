import type { LaunchProfile } from "../../../shared/cliLaunch";
import type { AgentChatPermissionMode } from "../../../shared/types";
import type { PtyCreateResult } from "../../../shared/types";

export * from "../../../shared/cliLaunch";

export type WorkPtyLaunchDisposition = "foreground" | "background";

export type WorkPtyLaunchArgs = {
  laneId: string;
  profile: LaunchProfile;
  title?: string;
  permissionMode?: AgentChatPermissionMode;
  startupCommand?: string;
  startupDelayMs?: number;
  initialInput?: string;
  initialInputDelayMs?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tracked?: boolean;
  disposition?: WorkPtyLaunchDisposition;
};

export type WorkPtyLaunchResult = PtyCreateResult;

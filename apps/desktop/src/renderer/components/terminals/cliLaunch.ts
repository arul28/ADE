import type { LaunchProfile } from "../../../shared/cliLaunch";
import type { AgentChatPermissionMode } from "../../../shared/types";
import type { LaneLinearIssue } from "../../../shared/types";
import type { PtyCreateResult } from "../../../shared/types";
import type { OpenProjectBinding } from "../../../shared/types/core";
import type { OrchestrationRole } from "../../../shared/types/orchestration";

export * from "../../../shared/cliLaunch";

export type WorkPtyLaunchDisposition = "foreground" | "background";

export type WorkPtyLaunchArgs = {
  laneId: string;
  profile: LaunchProfile;
  title?: string;
  permissionMode?: AgentChatPermissionMode;
  orchestrationRole?: OrchestrationRole | null;
  startupCommand?: string;
  startupDelayMs?: number;
  initialInput?: string;
  initialInputDelayMs?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tracked?: boolean;
  disposition?: WorkPtyLaunchDisposition;
  pin?: OpenProjectBinding | null;
  /**
   * Linear issues to attach to the launched terminal session before spawn, so
   * the CLI agent inherits `ADE_LINEAR_*` env and can drive its issue via
   * `ade linear`. Forwarded to `pty.create`.
   */
  linearIssues?: LaneLinearIssue[];
};

export type WorkPtyLaunchResult = PtyCreateResult;

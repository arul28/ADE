import type { LaunchProfile } from "../../../shared/cliLaunch";
import type {
  AgentChatPermissionMode,
  TerminalResumeLaunchConfig,
  TerminalResumeProvider,
} from "../../../shared/types";
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

const CONTINUATION_LAUNCH_LOOKUP_TTL_MS = 60_000;
const CONTINUATION_LAUNCH_LOOKUP_MAX_ENTRIES = 100;

type ContinuationLaunchLookup = {
  promise: Promise<TerminalResumeLaunchConfig | null>;
  expiresAt: number;
};

const continuationLaunchLookups = new Map<string, ContinuationLaunchLookup>();

export function mergeContinuationLaunch(
  recovered: TerminalResumeLaunchConfig | null,
  stored: TerminalResumeLaunchConfig | null,
): TerminalResumeLaunchConfig | null {
  if (!recovered) return stored;
  if (!stored) return recovered;
  const storedCoarsePermission = stored.permissionMode ?? null;
  return {
    ...recovered,
    ...stored,
    model: stored.model?.trim() || recovered.model?.trim() || null,
    reasoningEffort: stored.reasoningEffort?.trim() || recovered.reasoningEffort?.trim() || null,
    permissionMode: stored.permissionMode ?? recovered.permissionMode ?? null,
    fastMode: stored.fastMode ?? stored.codexFastMode ?? recovered.fastMode ?? recovered.codexFastMode ?? null,
    codexApprovalPolicy: stored.codexApprovalPolicy
      ?? (storedCoarsePermission ? null : recovered.codexApprovalPolicy)
      ?? null,
    codexSandbox: stored.codexSandbox
      ?? (storedCoarsePermission ? null : recovered.codexSandbox)
      ?? null,
    codexConfigSource: stored.codexConfigSource
      ?? (storedCoarsePermission ? null : recovered.codexConfigSource)
      ?? null,
  };
}

export function recoverImportedContinuationLaunch(
  provider: TerminalResumeProvider | null,
  importedProvider: TerminalResumeProvider | null,
  targetId: string,
): Promise<TerminalResumeLaunchConfig | null> | null {
  // Codex rollouts persist a turn_context record with the launch state. Other
  // providers currently do not expose an equivalent bounded exact lookup.
  if (provider !== "codex" || importedProvider !== provider || !targetId) return null;
  const key = `${provider}:${targetId}`;
  const now = Date.now();
  const existing = continuationLaunchLookups.get(key);
  if (existing && existing.expiresAt > now) {
    continuationLaunchLookups.delete(key);
    continuationLaunchLookups.set(key, existing);
    return existing.promise;
  }
  if (existing) continuationLaunchLookups.delete(key);
  let request: Promise<TerminalResumeLaunchConfig | null>;
  request = window.ade.externalSessions.list({
    providers: [provider],
    scope: "all",
    sessionId: targetId,
    limit: 1,
  }).then((sessions) => sessions.find((candidate) => candidate.id === targetId)?.launch ?? null)
    .catch((error) => {
      if (continuationLaunchLookups.get(key)?.promise === request) {
        continuationLaunchLookups.delete(key);
      }
      throw error;
    });
  continuationLaunchLookups.set(key, {
    promise: request,
    expiresAt: now + CONTINUATION_LAUNCH_LOOKUP_TTL_MS,
  });
  while (continuationLaunchLookups.size > CONTINUATION_LAUNCH_LOOKUP_MAX_ENTRIES) {
    const oldestKey = continuationLaunchLookups.keys().next().value;
    if (typeof oldestKey !== "string") break;
    continuationLaunchLookups.delete(oldestKey);
  }
  return request;
}

type WorkPtyPinLookup = {
  id?: string | null;
  sessionId?: string | null;
  ptyId?: string | null;
};

const workPtyLaunchPinsById = new Map<string, OpenProjectBinding>();

export function rememberWorkPtyLaunchPin(
  lookup: WorkPtyPinLookup,
  pin?: OpenProjectBinding | null,
): void {
  if (!pin) return;
  const sessionId = lookup.sessionId ?? lookup.id ?? null;
  if (sessionId) workPtyLaunchPinsById.set(sessionId, pin);
  if (lookup.ptyId) workPtyLaunchPinsById.set(lookup.ptyId, pin);
}

export function workPtyLaunchPinFor(lookup: WorkPtyPinLookup | null | undefined): OpenProjectBinding | null {
  if (!lookup) return null;
  const sessionId = lookup.sessionId ?? lookup.id ?? null;
  return (sessionId ? workPtyLaunchPinsById.get(sessionId) : undefined)
    ?? (lookup.ptyId ? workPtyLaunchPinsById.get(lookup.ptyId) : undefined)
    ?? null;
}

export function forgetWorkPtyLaunchPin(lookup: WorkPtyPinLookup): void {
  const sessionId = lookup.sessionId ?? lookup.id ?? null;
  if (sessionId) workPtyLaunchPinsById.delete(sessionId);
  if (lookup.ptyId) workPtyLaunchPinsById.delete(lookup.ptyId);
}

import { CheckCircle, CircleNotch, Warning } from "@phosphor-icons/react";
import type {
  AgentChatPermissionMode,
  AgentChatProvider,
  GitUpstreamSyncStatus,
  LaneSummary,
  RemoteRuntimeConnectionStatus,
} from "../../../shared/types";
import { providerDisplayLabel as providerDisplayLabelShared } from "../../../shared/pendingInputLabels";
import type { SafetyLevel } from "../shared/permissionOptions";
import type {
  PermissionModeIconKind,
  PermissionModeTone,
} from "../shared/PermissionModePicker";
import type { BlockedActionReason } from "../shared/BlockedAction";
import { cn } from "../ui/cn";

/**
 * Pure presentation for the cross-machine handoff modal — types, copy, the
 * safety/icon lookups, and the small row component.
 *
 * Split out because these are exactly the pieces that shipped wrong and were
 * unreachable from a test: the tone map silently rendered every permission pill
 * grey, and the branch row reported "main is pushed" for a branch that was two
 * commits behind. With no state and no hooks they can be asserted directly.
 */

export type SourceCheck = {
  lane: LaneSummary | null;
  sync: GitUpstreamSyncStatus | null;
  originUrl: string | null;
  branch: string | null;
  needsPush: boolean;
  /**
   * Reasons the handoff cannot start, each carrying the action that clears it.
   * Rendered — see `BlockedAction`. The previous shape was a bare `string[]` that
   * only ever fed a `disabled` prop, which is how a behind branch became an
   * invisible block behind three green check rows.
   */
  blockingErrors: BlockedActionReason[];
  warnings: string[];
};

export type ModalStage = "choose" | "clone" | "review" | "sending" | "complete";
export type HandoffMode = "brief" | "fork";

export type ForkHandoffSupport = { supported: boolean; reason?: string };

/** Ordered checkpoints shown while a handoff is in flight. */
export const SEND_STEPS = [
  { id: "validate", label: "Rechecked your branch and chat" },
  { id: "accept", label: "Created the lane and chat there" },
] as const;
export type SendStep = (typeof SEND_STEPS)[number]["id"];

export const CROSS_MACHINE_HANDOFF_STILL_COMPLETING_MESSAGE =
  "ADE lost confirmation from the destination while it was creating the handoff. "
  + "The new chat may still appear there. Check that computer before retrying; retrying this handoff is safe.";

export function providerDisplayLabel(provider: AgentChatProvider | null | undefined): string {
  return providerDisplayLabelShared(provider, "This chat");
}

/**
 * Prepare errors that mean "this chat can't fork, but a brief always can" — the
 * source history is over the transport cap ("too large"), or the provider's
 * native session file can't be forked at all (e.g. a Codex `.zst` rollout). Both
 * get the one-click brief fallback; the plain-language reason differs by cause.
 */
export function forkFallbackReasonForPrepareError(message: string): string | null {
  if (/too large|too big/i.test(message)) {
    return "This chat's history is too big to send — a brief works everywhere.";
  }
  if (/can'?t be forked|cannot be forked|not forkable/i.test(message)) {
    return "This chat's history can't be forked — a brief works everywhere.";
  }
  if (/aren'?t portable|not portable/i.test(message)) {
    return "This chat's history can't move between machines — a brief works everywhere.";
  }
  return null;
}

/**
 * `permissionOptions.ts` describes an option by safety level, while the picker
 * pill styles by tone. Both maps are keyed on the real unions rather than
 * `Record<string, …>`: the first draft invented its own key names, every lookup
 * silently fell through to the default tone, and the whole row rendered grey
 * while the composer's rendered green/amber/red. An exhaustive Record makes the
 * compiler name any key a union gains.
 */
export const PERMISSION_SAFETY_TONES: Record<SafetyLevel, PermissionModeTone> = {
  safe: "green",
  "semi-auto": "amber",
  "full-auto": "red",
  danger: "red",
  custom: "slate",
};

export const PERMISSION_MODE_ICONS: Record<AgentChatPermissionMode, PermissionModeIconKind> = {
  default: "manual",
  auto: "auto",
  plan: "plan",
  edit: "edit",
  "full-auto": "full",
  "config-toml": "config",
};

export const EMPTY_SOURCE_CHECK: SourceCheck = {
  lane: null,
  sync: null,
  originUrl: null,
  branch: null,
  needsPush: false,
  blockingErrors: [],
  warnings: [],
};

export function repoNameFromRemote(value: string): string {
  const normalized = value.trim().replace(/[\\/]$/, "").replace(/\.git$/i, "");
  return normalized.split(/[/:]/).filter(Boolean).at(-1) || "repository";
}

export function routeLabel(connection: RemoteRuntimeConnectionStatus): string {
  switch (connection.route?.kind) {
    case "tailnet": return "Tailscale · encrypted";
    case "ssh": return "SSH · encrypted";
    case "relay": return "ADE relay";
    case "lan": return "Local network";
    default: return "Connected route";
  }
}

export function isInsecureRoute(connection: RemoteRuntimeConnectionStatus | null): boolean {
  return connection?.route?.kind === "lan" || connection?.route?.kind === "relay";
}

/**
 * The "Remote branch" row has to speak about both directions of drift. It used
 * to read only `needsPush`, so a branch that was fully pushed but several
 * commits *behind* origin rendered a green "main is pushed" — while the very
 * same state silently disabled Continue.
 */
export function branchRowDetail(check: SourceCheck): string {
  if (!check.branch) return "Branch unavailable";
  if (check.sync?.diverged) return `${check.branch} has diverged from origin`;
  if ((check.sync?.behind ?? 0) > 0) {
    const behind = check.sync?.behind ?? 0;
    return `${check.branch} is ${behind} ${behind === 1 ? "commit" : "commits"} behind origin`;
  }
  if (check.needsPush) return "This branch still needs to be pushed";
  return `${check.branch} is pushed and up to date`;
}

export function branchRowState(check: SourceCheck): "ok" | "warn" | "error" {
  if (!check.branch) return "error";
  if (check.sync?.diverged || (check.sync?.behind ?? 0) > 0) return "error";
  if (check.needsPush) return "warn";
  return "ok";
}

/**
 * Copy for the per-machine repository hint. "unknown" and "checking" render
 * nothing rather than a hedge — an unanswered question isn't worth a row.
 */
export function repoReadinessLabel(state: "checking" | "present" | "absent" | "unknown" | undefined): string | null {
  if (state === "present") return "repo ready";
  if (state === "absent") return "will clone the repo";
  return null;
}

export function repoReadinessClass(state: "checking" | "present" | "absent" | "unknown" | undefined): string {
  return state === "present" ? "text-emerald-300/60" : "text-amber-200/60";
}

export function CheckRow({
  label,
  detail,
  state,
}: {
  label: string;
  detail: string;
  state: "ok" | "warn" | "error" | "pending";
}) {
  const Icon = state === "ok" ? CheckCircle : state === "pending" ? CircleNotch : Warning;
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.055] bg-white/[0.025] px-3 py-2.5">
      <Icon
        size={16}
        weight={state === "ok" ? "fill" : "regular"}
        className={cn(
          "mt-0.5 shrink-0",
          state === "ok" && "text-emerald-300/85",
          state === "warn" && "text-amber-300/85",
          state === "error" && "text-red-300/85",
          state === "pending" && "animate-spin text-fg/40",
        )}
      />
      <div className="min-w-0">
        <div className="font-sans text-[11px] font-semibold text-fg/80">{label}</div>
        <div className="mt-0.5 text-[10px] leading-4 text-fg/46">{detail}</div>
      </div>
    </div>
  );
}

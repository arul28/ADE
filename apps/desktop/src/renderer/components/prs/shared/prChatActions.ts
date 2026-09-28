import type { AgentChatSessionSummary, OpenProjectBinding, PrReviewThread, PrWithConflicts } from "../../../../shared/types";
import { digestPreview } from "../../../../shared/prConversationDigest";
import { pipelineStateOf, type PrPipelineStateInput } from "../../../../shared/prPipelineState";
import { queueAgentChatDraftHandoff } from "../../../lib/agentChatDraftHandoff";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { useCallback } from "react";
import { selectActiveProjectStateKey, useAppStore } from "../../../state/appStore";
import { machineIdForBinding } from "../../../../shared/machineIdentity";
import { chatDraftMachineId, startChatDraftPatch } from "../../../lib/workDraft";
import { usePrRuntimePin } from "../state/prMachines";

/**
 * PR → chat hand-offs. Every action writes a prompt into a chat composer and
 * never sends it: the reader reads it over first. The PR menu, the sidebar
 * right-click menu, the Needs-attention rows, and the Merge card all go
 * through here, so the wording and the chat choice cannot drift.
 */

export type PrChatActionKind =
  | "ask"
  | "explain"
  | "fix_findings"
  | "fix_checks"
  | "resolve_conflicts"
  | "update_description";

type PrRef = Pick<PrWithConflicts, "githubPrNumber" | "repoOwner" | "repoName" | "headBranch" | "baseBranch" | "title" | "githubUrl">;

export type PrChatFinding = {
  author: string;
  path: string | null;
  line: number | null;
  body: string | null;
  url: string | null;
};

const MAX_FINDINGS = 25;

/**
 * The open review findings: unresolved threads that are not outdated. The ⋯
 * menu and the Merge card both hand these to a chat, so they read them here.
 */
export function prOpenFindings(threads: readonly PrReviewThread[]): PrChatFinding[] {
  return threads
    .filter((thread) => !thread.isResolved && !thread.isOutdated)
    .map((thread) => ({
      author: thread.comments[0]?.author ?? "reviewer",
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      body: thread.comments[0]?.body ?? null,
      url: thread.url,
    }));
}

/** Names of the checks that failed, by the same rule as every other check surface. */
export function prFailingCheckNames(
  checks: ReadonlyArray<PrPipelineStateInput & { name: string; displayName?: string | null }>,
): string[] {
  return checks
    .filter((check) => pipelineStateOf(check) === "failed")
    .map((check) => check.displayName || check.name);
}

function prLine(pr: PrRef): string {
  return `${pr.repoOwner}/${pr.repoName} PR #${pr.githubPrNumber} "${pr.title}" (${pr.headBranch} → ${pr.baseBranch}) — ${pr.githubUrl}`;
}

export function buildPrChatPrompt(
  kind: PrChatActionKind,
  pr: PrRef,
  extra: { findings?: PrChatFinding[]; failingChecks?: string[] } = {},
): string {
  switch (kind) {
    case "ask":
      return `About ${prLine(pr)}:\n\n`;
    case "explain":
      return [
        `Explain ${prLine(pr)}.`,
        "Walk me through what the diff changes and why, in the order I should read it. Point out the parts that deserve a close look (risky logic, migrations, public contracts) and anything that looks unfinished.",
      ].join("\n\n");
    case "fix_findings": {
      const findings = extra.findings ?? [];
      const shown = findings.slice(0, MAX_FINDINGS);
      const lines = shown.map((finding, index) => {
        const where = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ""}` : "general";
        const link = finding.url ? ` (${finding.url})` : "";
        return `${index + 1}. [${finding.author}] ${where} — ${digestPreview(finding.body, 220)}${link}`;
      });
      return [
        `Address the open review findings on ${prLine(pr)}.`,
        lines.length > 0
          ? `Open threads:\n${lines.join("\n")}${findings.length > shown.length ? `\n…and ${findings.length - shown.length} more.` : ""}`
          : "No unresolved threads were loaded; read the PR conversation first.",
        "For each one, decide whether it is valid. Fix the valid ones with the smallest correct change, and say which ones you reject and why. Run the relevant tests, then summarize what changed.",
      ].join("\n\n");
    }
    case "fix_checks": {
      const checks = extra.failingChecks ?? [];
      return [
        `Fix the failing checks on ${prLine(pr)}.`,
        checks.length > 0 ? `Failing: ${checks.slice(0, 15).join(", ")}${checks.length > 15 ? ", …" : ""}.` : null,
        "Read the check logs, reproduce the failure locally when practical, make the smallest correct fix, run the checks again, and report what changed.",
      ].filter(Boolean).join("\n\n");
    }
    case "resolve_conflicts":
      return [
        `Resolve the merge conflicts between ${pr.headBranch} and ${pr.baseBranch} on ${prLine(pr)}.`,
        `Bring ${pr.baseBranch} into the branch, resolve each conflict by keeping the intent of both sides, run the tests that cover the touched files, and push. List every file you resolved and any choice that needed judgment.`,
      ].join("\n\n");
    case "update_description":
      return [
        `Rewrite the description of ${prLine(pr)} from the current diff.`,
        "Keep the existing sections if they are still true. Cover why, what changed, and how it was tested. Show me the new text before you update the PR.",
      ].join("\n\n");
  }
}

export function newestWorkChat(sessions: AgentChatSessionSummary[]): AgentChatSessionSummary | null {
  const timestamp = (session: AgentChatSessionSummary): number => {
    const parsed = Date.parse(session.lastActivityAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return sessions
    .filter((session) => (session.surface ?? "work") === "work" && session.archivedAt == null)
    .sort((left, right) => timestamp(right) - timestamp(left))[0] ?? null;
}

/**
 * Chats that belong to this PR: the ones it names in `chatSessionIds`, newest
 * first. A lane-owned PR with no explicit links falls back to nothing — the
 * caller then offers "start a chat in the lane".
 */
export function linkedPrChats(
  pr: Pick<PrWithConflicts, "chatSessionIds">,
  laneChats: AgentChatSessionSummary[],
): AgentChatSessionSummary[] {
  const ids = new Set((pr.chatSessionIds ?? []).filter(Boolean));
  if (ids.size === 0) return [];
  const timestamp = (session: AgentChatSessionSummary): number => {
    const parsed = Date.parse(session.lastActivityAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return laneChats
    .filter((session) => ids.has(session.sessionId) && session.archivedAt == null)
    .sort((left, right) => timestamp(right) - timestamp(left));
}

export function chatLabel(session: Pick<AgentChatSessionSummary, "title" | "sessionId">): string {
  const title = session.title?.trim();
  return title && title.length > 0 ? title : `Chat ${session.sessionId.slice(0, 6)}`;
}

/**
 * Put `prompt` in a chat composer and go there. `sessionId: null` starts a new
 * chat in the PR's lane (the lane-owned PR is in every lane chat's PR scope).
 */
export function handPromptToChat(args: { laneId: string; sessionId: string | null; prompt: string }): void {
  if (args.sessionId) {
    queueAgentChatDraftHandoff({ sessionId: args.sessionId }, args.prompt);
    navigateToAppTarget({ kind: "work", laneId: args.laneId, sessionId: args.sessionId });
    return;
  }
  queueAgentChatDraftHandoff({ draftTargetId: `work:draft:${args.laneId}:chat` }, args.prompt);
  navigateToAppTarget({ kind: "work", laneId: args.laneId });
}

export type PrChatHandoffArgs = {
  laneId: string;
  /** An existing chat, or null to start a new chat in the lane. */
  sessionId: string | null;
  /** Written into the composer, never sent. Omit to just open the chat. */
  prompt?: string | null;
};

/**
 * `handPromptToChat` that knows which machine the PR's lane lives on.
 *
 * On the tab's machine it is exactly `handPromptToChat`. For a lane on another
 * machine (the PR runtime pin is set) the Work tab must not resolve the bare
 * lane or session id against the tab's machine: an existing chat is focused
 * with its binding (`ade:work:select-session`), and a new chat starts as a
 * draft that carries the owner machine (`startChatDraftPatch`), the same way
 * `useStartChatInLane` does.
 */
export function usePrChatHandoff(
  /** The pane that sets the pin passes it directly; its own context is outside it. */
  pinOverride?: OpenProjectBinding | null,
): (args: PrChatHandoffArgs) => void {
  const contextPin = usePrRuntimePin();
  const pin = pinOverride !== undefined ? pinOverride : contextPin;
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const projectBinding = useAppStore((state) => state.projectBinding);
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);
  return useCallback((args: PrChatHandoffArgs) => {
    const prompt = args.prompt ?? null;
    if (!pin) {
      if (prompt != null) {
        handPromptToChat({ laneId: args.laneId, sessionId: args.sessionId, prompt });
      } else {
        navigateToAppTarget({ kind: "work", laneId: args.laneId, sessionId: args.sessionId });
      }
      return;
    }
    if (args.sessionId) {
      if (prompt != null) queueAgentChatDraftHandoff({ sessionId: args.sessionId }, prompt);
      window.dispatchEvent(new CustomEvent("ade:work:select-session", {
        detail: { sessionId: args.sessionId, laneId: args.laneId, binding: pin },
      }));
      navigateToAppTarget({ kind: "work" });
      return;
    }
    if (prompt != null) {
      queueAgentChatDraftHandoff({ draftTargetId: `work:draft:${args.laneId}:chat` }, prompt);
    }
    const draftMachineId = chatDraftMachineId(machineIdForBinding(pin), machineIdForBinding(projectBinding));
    if (projectStateKey) {
      setWorkViewState(projectStateKey, (prev) => ({
        ...prev,
        ...startChatDraftPatch(args.laneId, draftMachineId),
      }));
    }
    navigateToAppTarget({ kind: "work" });
  }, [pin, projectBinding, projectStateKey, setWorkViewState]);
}

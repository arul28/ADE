/**
 * The source brain's side of moving a chat to another machine, kept out of
 * agentChatService: where a move is stored, what on the source blocks one, and
 * the outbox that lets a retry finish a move instead of starting it over.
 * The orchestrator (crossMachineHandoffOrchestrator.ts) drives the steps.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  AgentChatCrossMachineHandoffBlocker,
  AgentChatCrossMachineHandoffRecord,
  AgentChatEventMetadata,
  LaneSummary,
} from "../../../shared/types";
import {
  isCrossMachineHandoffActive,
  normalizeGitRemoteIdentity,
  sanitizePortableGitRemote,
} from "../../../shared/crossMachineHandoff";
import type { GitRunOptions, GitRunResult } from "../git/git";
import type { AdeDb } from "../state/kvDb";
import { writeFileAtomic } from "../state/durableFile";
import { messageClearsAttentionMarkers } from "./spawnMissionOwnership";
import type {
  CrossMachineHandoffOutbox,
  CrossMachineHandoffPersisted,
  CrossMachinePreparedCapsule,
  CrossMachineSourceInspection,
} from "./crossMachineHandoffOrchestrator";

type RunGit = (args: string[], opts: GitRunOptions) => Promise<GitRunResult>;

export type CrossMachineHandoffSourceDeps = {
  runGit: RunGit;
  laneService: { getSummary(laneId: string, options: { includeStatus?: boolean }): Promise<LaneSummary | null> };
  db: (Pick<AdeDb, "getJson" | "setJson"> & Partial<Pick<AdeDb, "all">>) | null | undefined;
  /** Machine-local folder for prepared capsules (under the project's .ade). */
  outboxDir: string;
};

const MOVE_KEY_PREFIX = "agent-chat-cross-machine-move:v1:";

/**
 * Whether a user_message came from the person. Host-authored deliveries (a
 * scheduled wake, a subagent's report, another agent's relay, a continuation
 * ADE wrote, a PR Watch wake, a usage-limit resume, a parent's dispatch) are
 * not new instructions, so they must not cancel a queued move.
 */
export function isPersonAuthoredUserMessage(metadata: AgentChatEventMetadata | null | undefined): boolean {
  if (!metadata) return true;
  if (metadata.usageLimitResume || metadata.spawnDispatch || metadata.orchestrationOrigin) return false;
  return messageClearsAttentionMarkers(metadata);
}

export function createCrossMachineHandoffSource(deps: CrossMachineHandoffSourceDeps) {
  const moveKey = (sessionId: string): string => `${MOVE_KEY_PREFIX}${sessionId}`;

  const readMove = (sessionId: string): CrossMachineHandoffPersisted | null => {
    const value = deps.db?.getJson<unknown>(moveKey(sessionId));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const persisted = value as Partial<CrossMachineHandoffPersisted>;
    if (!persisted.record || !persisted.request || typeof persisted.record.handoffId !== "string") return null;
    return persisted as CrossMachineHandoffPersisted;
  };

  /** Null clears the chat's move (it stores JSON null, which reads as none). */
  const writeMove = (sessionId: string, value: CrossMachineHandoffPersisted | null): void => {
    deps.db?.setJson(moveKey(sessionId), value);
  };

  const listMoves = (): Array<{ sessionId: string; value: CrossMachineHandoffPersisted }> => {
    const rows = deps.db?.all?.<{ key: string }>("select key from kv where key like ?", [`${MOVE_KEY_PREFIX}%`]) ?? [];
    const moves: Array<{ sessionId: string; value: CrossMachineHandoffPersisted }> = [];
    for (const row of rows) {
      const sessionId = row.key.slice(MOVE_KEY_PREFIX.length);
      const value = readMove(sessionId);
      if (value) moves.push({ sessionId, value });
    }
    return moves;
  };

  /**
   * Everything on the source lane that stops a move, as a list rather than
   * the first thrown error, so a person and an agent both see every fix at
   * once. The one canonical source check: the send path
   * (`requireCrossMachineSourceReady`) refuses on these same blockers.
   */
  const inspectLane = async (
    lane: LaneSummary,
    options: { activeMove?: AgentChatCrossMachineHandoffRecord | null } = {},
  ): Promise<CrossMachineSourceInspection> => {
    const blockers: AgentChatCrossMachineHandoffBlocker[] = [];
    const cwd = lane.worktreePath;
    const gitText = async (args: string[], timeoutMs = 15_000): Promise<string | null> => {
      const result = await deps.runGit(args, { cwd, timeoutMs });
      return result.exitCode === 0 ? result.stdout.trim() : null;
    };
    const laneFlag = `--lane ${lane.id}`;
    if (lane.status?.rebaseInProgress) {
      blockers.push({
        id: "rebasing",
        title: "A rebase is in progress",
        detail: "Finish or abort it before moving this chat.",
        clearedByIncludeChanges: false,
        fixHint: `finish the rebase in ${lane.name}`,
      });
    }
    const mergeHead = await gitText(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], 8_000);
    if (mergeHead && /^[0-9a-f]{40,64}$/i.test(mergeHead)) {
      blockers.push({
        id: "merging",
        title: "A merge is in progress",
        detail: "Finish or abort it before moving this chat.",
        clearedByIncludeChanges: false,
        fixHint: `finish or abort the merge in ${lane.name}`,
      });
    }
    const rawOrigin = await gitText(["remote", "get-url", "origin"]);
    const originUrl = rawOrigin ? normalizeGitRemoteIdentity(sanitizePortableGitRemote(rawOrigin)) : null;
    if (!originUrl) {
      blockers.push({
        id: "no_origin",
        title: "This project has no origin remote",
        detail: "The other machine finds the repository by its origin.",
        clearedByIncludeChanges: false,
        fixHint: null,
      });
    }
    const branchRef = await gitText(["symbolic-ref", "--short", "HEAD"]);
    const headSha = await gitText(["rev-parse", "HEAD"]);
    const status = await deps.runGit(["status", "--porcelain=v1"], { cwd, timeoutMs: 15_000 });
    if (status.exitCode !== 0) {
      throw new Error(`ADE could not inspect the source lane. ${status.stderr.trim()}`.trim());
    }
    const changedFiles = status.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
    if (changedFiles > 0) {
      blockers.push({
        id: "dirty",
        title: `${changedFiles} uncommitted change${changedFiles === 1 ? "" : "s"}`,
        detail: "Commit them, or bring them along to the other machine.",
        clearedByIncludeChanges: true,
        fixHint: `commit in ${lane.name}, or pass --include-changes`,
      });
    }
    // Only origin counts: the other machine fetches from origin.
    const unpushedText = await gitText(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
    const unpushedCommits = unpushedText ? Number.parseInt(unpushedText, 10) || 0 : 0;
    const upstreamSha = await gitText(["rev-parse", "@{upstream}"]);
    const upstream = upstreamSha
      ? (await gitText(["rev-parse", "--abbrev-ref", "@{upstream}"])) || "its upstream"
      : null;
    if (!upstream) {
      blockers.push({
        id: "no_upstream",
        title: `${branchRef ?? "This branch"} hasn't been published`,
        detail: "The other machine fetches the branch from origin.",
        clearedByIncludeChanges: true,
        fixHint: `run \`ade git push ${laneFlag}\`, or pass --include-changes`,
      });
    } else {
      const counts = await gitText(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
      const [behind = 0, ahead = 0] = (counts ?? "0 0").split(/\s+/).map((part) => Number.parseInt(part, 10) || 0);
      if (behind > 0 && ahead > 0) {
        blockers.push({
          id: "diverged",
          title: `${branchRef ?? "This branch"} has diverged from ${upstream}`,
          detail: "Reconcile it (rebase or merge) yourself; ADE won't pick a strategy.",
          clearedByIncludeChanges: false,
          fixHint: null,
        });
      } else if (behind > 0) {
        blockers.push({
          id: "behind",
          title: `${branchRef ?? "This branch"} is ${behind} commit${behind === 1 ? "" : "s"} behind ${upstream}`,
          detail: "Update it so both machines start from the same commit.",
          clearedByIncludeChanges: false,
          fixHint: `run \`ade git pull ${laneFlag}\``,
        });
      } else if (ahead > 0) {
        blockers.push({
          id: "unpushed",
          title: `${ahead} unpushed commit${ahead === 1 ? "" : "s"}`,
          detail: "Push them, or bring them along to the other machine.",
          clearedByIncludeChanges: true,
          fixHint: `run \`ade git push ${laneFlag}\`, or pass --include-changes`,
        });
      }
    }
    const move = options.activeMove;
    if (move && isCrossMachineHandoffActive(move)) {
      blockers.push({
        id: "move_in_progress",
        title: `Already moving to ${move.targetMachineName}`,
        detail: "Cancel that move first.",
        clearedByIncludeChanges: false,
        fixHint: "run `ade chat handoff <session> --cancel`",
      });
    }
    return {
      originUrl,
      rawOriginUrl: rawOrigin || null,
      branchRef,
      headSha,
      blockers,
      changes: changedFiles > 0 || unpushedCommits > 0 ? { unpushedCommits, changedFiles } : null,
    };
  };

  /** A chat's lane, inspected with its own move counted as a blocker. */
  const inspect = async (sessionId: string, laneId: string): Promise<CrossMachineSourceInspection> => {
    const lane = await deps.laneService.getSummary(laneId, { includeStatus: true });
    if (!lane) return { originUrl: null, rawOriginUrl: null, branchRef: null, headSha: null, blockers: [], changes: null };
    return inspectLane(lane, { activeMove: readMove(sessionId)?.record ?? null });
  };

  /**
   * The exact capsule a move handed to the destination, written before
   * acceptance starts and removed once the move ends. A retry of a move whose
   * answer was lost resends this same capsule, so the destination reconciles
   * through its record for that handoffId instead of refusing a re-prepared
   * capsule with different content.
   */
  const outboxPath = (handoffId: string): string =>
    // Handoff ids may hold `:`, which Windows file names cannot.
    path.join(deps.outboxDir, `${handoffId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

  const outbox: CrossMachineHandoffOutbox = {
    read: (handoffId) => {
      let raw: string;
      try {
        raw = fs.readFileSync(outboxPath(handoffId), "utf8");
      } catch {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as Partial<CrossMachinePreparedCapsule> & { handoffId?: unknown };
        if (
          parsed.handoffId !== handoffId
          || !parsed.capsule
          || parsed.capsule.handoffId !== handoffId
          || typeof parsed.capsuleFingerprint !== "string"
        ) {
          return null;
        }
        return { capsule: parsed.capsule, capsuleFingerprint: parsed.capsuleFingerprint };
      } catch {
        return null;
      }
    },
    write: (handoffId, prepared) => {
      fs.mkdirSync(deps.outboxDir, { recursive: true });
      writeFileAtomic(
        outboxPath(handoffId),
        JSON.stringify({ handoffId, capsule: prepared.capsule, capsuleFingerprint: prepared.capsuleFingerprint }),
        { fsync: true },
      );
    },
    remove: (handoffId) => {
      try {
        fs.rmSync(outboxPath(handoffId), { force: true });
      } catch {
        // A leftover outbox file is only a stale copy of a capsule.
      }
    },
  };

  return { readMove, writeMove, listMoves, inspect, inspectLane, outbox };
}

export type CrossMachineHandoffSourceStore = ReturnType<typeof createCrossMachineHandoffSource>;

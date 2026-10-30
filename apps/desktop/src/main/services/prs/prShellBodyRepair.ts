/**
 * Repairs the text of a pull request a chat wrote with `gh pr create` or
 * `gh pr edit --body`. Those commands replace the whole text, so ADE's
 * "Open in ADE" footer and Linear reference go, and proof the text cites
 * (`![caption](ade-proof://id)`, ```proof-compare blocks) stays as links
 * GitHub cannot show.
 *
 * The repair puts the footer back and uploads the cited proof the way
 * `ade prs body` does (`stagePrBodyProof`). Only proof owned by the chat or its
 * lane goes up; any other citation, and every other line of the text, stays
 * as the agent wrote it. Only the lane's own open PR in this repository is
 * touched. One repair runs per PR at a time, and before it writes it reads the
 * text again: a newer edit wins and gets a repair of its own.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prBodyProofIds } from "../../../shared/prBodyProof";
import type { LaneSummary } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { asString, getErrorMessage } from "../shared/utils";
import { ghVersionCanAttach, parseGhVersion, stagePrBodyProof, type PublishableArtifact } from "./prBodyProofStaging";

type GitHubRepoRef = { owner: string; name: string };

export type ShellPrBodyRepairArgs = {
  sessionId: string;
  repoOwner: string | null;
  repoName: string | null;
  /** Null when the command named no PR: it acted on the lane branch's PR. */
  prNumber: number | null;
  /** The chat's and lane's own proof among `ids`; nobody else's. */
  listOwnedProof: (args: { ids: string[]; owners: Array<{ kind: "chat_session" | "lane"; id: string }> }) => PublishableArtifact[];
  /** Records the PR on each uploaded proof item, as `ade proof publish` does. */
  linkProofToPr: (args: { artifactIds: string[]; prUrl: string }) => void;
};

export type ShellPrBodyRepairResult =
  | { status: "repaired"; footer: boolean; uploaded: string[]; skipped: Array<{ id: string; reason: string }> }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string };

export type ShellPrBodyRepairDeps = {
  logger: Logger;
  projectRoot: string;
  /** The lane chat the command ran in, the repository, and the session's canonical id; or why not. */
  resolveChatLane: (sessionId: string) => Promise<
    | { sessionId: string; lane: LaneSummary; repo: GitHubRepoRef; sameRepo: (owner: unknown, name: unknown) => boolean }
    | { skip: string }
  >;
  /** Why this PR is not the lane's own branch PR in the repository, or null when it is. */
  pullMismatch: (pull: any, lane: LaneSummary, sameRepo: (owner: unknown, name: unknown) => boolean) => string | null;
  lanePrNumber: (lane: LaneSummary) => number | null;
  fetchPull: (repo: GitHubRepoRef, prNumber: number) => Promise<any>;
  /** The text with ADE's footer and Linear reference for this lane's PR. */
  stampBody: (text: string, lane: LaneSummary, repo: GitHubRepoRef, prNumber: number) => string;
  patchBody: (repo: GitHubRepoRef, prNumber: number, body: string) => Promise<void>;
  runGh: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export function createShellPrBodyRepair(deps: ShellPrBodyRepairDeps) {
  const { logger } = deps;
  /**
   * Per PR: the pass running now, at most one queued after it, and the newest
   * request, which the queued pass runs with (its chat's proof counts).
   */
  type Slot = {
    running: Promise<ShellPrBodyRepairResult>;
    next: Promise<ShellPrBodyRepairResult> | null;
    latest: () => Promise<ShellPrBodyRepairResult>;
  };
  const slots = new Map<string, Slot>();
  /** `gh` 2.99+ is on this machine. Only a yes is remembered: an upgrade needs no restart. */
  let ghCanAttach = false;

  const serialized = (key: string, work: () => Promise<ShellPrBodyRepairResult>): Promise<ShellPrBodyRepairResult> => {
    const slot = slots.get(key);
    if (slot) {
      // One queued pass covers every command that lands meanwhile: it reads
      // the newest text, for the newest request.
      slot.latest = work;
      slot.next ??= slot.running.catch(() => undefined).then(() => slot.latest());
      return slot.next;
    }
    const fresh: Slot = { running: work(), next: null, latest: work };
    const advance = () => {
      if (!fresh.next) {
        slots.delete(key);
        return;
      }
      fresh.running = fresh.next;
      fresh.next = null;
      fresh.running.then(advance, advance);
    };
    fresh.running.then(advance, advance);
    slots.set(key, fresh);
    return fresh.running;
  };

  const skip = (args: ShellPrBodyRepairArgs, reason: string): ShellPrBodyRepairResult => {
    logger.info("prs.shell_body_repair_skipped", { sessionId: args.sessionId, prNumber: args.prNumber, reason });
    return { status: "skipped", reason };
  };

  const canAttach = async (): Promise<boolean> => {
    if (ghCanAttach) return true;
    const version = await deps.runGh(["--version"], { cwd: deps.projectRoot, timeoutMs: 30_000 });
    ghCanAttach = version.exitCode === 0 && ghVersionCanAttach(parseGhVersion(version.stdout));
    return ghCanAttach;
  };

  /** False when the PR's text changed since `body` was read: a newer edit's own repair covers it. */
  const stillReads = async (repo: GitHubRepoRef, prNumber: number, body: string): Promise<boolean> => {
    const pull = await deps.fetchPull(repo, prNumber);
    return (typeof pull?.body === "string" ? pull.body : "") === body;
  };

  const repairOnce = async (
    args: ShellPrBodyRepairArgs,
    target: { sessionId: string; lane: LaneSummary; repo: GitHubRepoRef; prNumber: number; sameRepo: (owner: unknown, name: unknown) => boolean },
  ): Promise<ShellPrBodyRepairResult> => {
    const { lane, repo, prNumber, sessionId } = target;
    let pull: any;
    try {
      pull = await deps.fetchPull(repo, prNumber);
    } catch (error) {
      logger.warn("prs.shell_body_repair_github_read_failed", { prNumber, error: getErrorMessage(error) });
      return skip(args, "github_unreadable");
    }
    const mismatch = deps.pullMismatch(pull, lane, target.sameRepo);
    if (mismatch) return skip(args, mismatch);
    if (pull?.state !== "open") return skip(args, "not_open");

    const body = typeof pull?.body === "string" ? pull.body : "";
    const citedIds = prBodyProofIds(body);
    const owners: Array<{ kind: "chat_session" | "lane"; id: string }> = [{ kind: "chat_session", id: sessionId }, { kind: "lane", id: lane.id }];
    if (args.sessionId !== sessionId) owners.push({ kind: "chat_session", id: args.sessionId });
    const artifacts = citedIds.length ? args.listOwnedProof({ ids: citedIds, owners }) : [];
    if (artifacts.length && !(await canAttach())) logger.info("prs.shell_body_repair_no_gh_attach", { prNumber });

    if (artifacts.length && ghCanAttach) {
      const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-pr-body-proof-"));
      try {
        const staged = stagePrBodyProof({ body, artifacts, projectRoot: deps.projectRoot, staging });
        if (staged.posted.length) {
          const next = deps.stampBody(staged.rewritten, lane, repo, prNumber);
          await fs.promises.writeFile(path.join(staging, "body.md"), next);
          if (!(await stillReads(repo, prNumber, body))) return skip(args, "superseded");
          const prUrl = asString(pull?.html_url) || `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}`;
          // Run from the staging directory: gh resolves `./proof-N.ext` against it.
          const edit = await deps.runGh(
            ["pr", "edit", prUrl, "--body-file", "body.md", ...staged.posted.flatMap((entry) => ["--attach", `./${entry.file}`])],
            { cwd: staging, timeoutMs: UPLOAD_TIMEOUT_MS },
          );
          if (edit.exitCode === 0) {
            const uploaded = staged.posted.map((entry) => entry.id);
            try {
              args.linkProofToPr({ artifactIds: uploaded, prUrl });
            } catch (error) {
              logger.warn("prs.shell_body_repair_proof_link_failed", { prNumber, error: getErrorMessage(error) });
            }
            const footer = next !== staged.rewritten;
            logger.info("prs.shell_body_repaired", { sessionId, prNumber, footer, uploaded, skipped: staged.skipped });
            return { status: "repaired", footer, uploaded, skipped: staged.skipped };
          }
          // The footer still goes back below; the citations stay for ADE to show.
          logger.warn("prs.shell_body_repair_upload_failed", { prNumber, error: edit.stderr.trim().slice(0, 500) });
        }
      } finally {
        await fs.promises.rm(staging, { recursive: true, force: true }).catch((error) => {
          logger.warn("prs.shell_body_repair_staging_cleanup_failed", { error: getErrorMessage(error) });
        });
      }
    }

    // No proof to upload, or the upload could not run: the footer still goes back.
    const next = deps.stampBody(body, lane, repo, prNumber);
    if (next === body) return { status: "unchanged" };
    try {
      if (!(await stillReads(repo, prNumber, body))) return skip(args, "superseded");
      await deps.patchBody(repo, prNumber, next);
    } catch (error) {
      logger.warn("prs.shell_body_repair_patch_failed", { prNumber, error: getErrorMessage(error) });
      return skip(args, "patch_failed");
    }
    logger.info("prs.shell_body_repaired", { sessionId, prNumber, footer: true, uploaded: [] });
    return { status: "repaired", footer: true, uploaded: [], skipped: [] };
  };

  return {
    async repair(args: ShellPrBodyRepairArgs): Promise<ShellPrBodyRepairResult> {
      const chat = await deps.resolveChatLane(args.sessionId);
      if ("skip" in chat) return skip(args, chat.skip);
      if (args.repoOwner && args.repoName && !chat.sameRepo(args.repoOwner, args.repoName)) return skip(args, "other_repo");
      const prNumber = args.prNumber ?? deps.lanePrNumber(chat.lane);
      if (!prNumber) return skip(args, "no_lane_pr");
      const target = { ...chat, prNumber };
      return serialized(`${chat.repo.owner}/${chat.repo.name}#${prNumber}`.toLowerCase(), () => repairOnce(args, target));
    },
  };
}

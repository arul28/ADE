/**
 * `ade proof publish`: puts proof on a GitHub pull request. Either as one
 * comment of chosen items (`gh pr comment --attach`), or in the PR's own text,
 * where the author cited it (`gh pr edit --attach`).
 *
 * GitHub stores the pictures and videos as its own attachments, with the
 * repository's privacy. ADE hosts nothing and pushes no proof branch. `gh`
 * rewrites each `![caption](./file)` reference in the body to the uploaded
 * asset, so the comment reads like the agent's answer: each item under its
 * caption.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ghVersionCanAttach,
  parseGhVersion,
  stagePrBodyProof,
  stageProofFile,
  type PublishableArtifact,
} from "../../desktop/src/main/services/prs/prBodyProofStaging";

export type ProofPublishResult = {
  prUrl: string;
  commentUrl: string | null;
  posted: Array<{ id: string; caption: string; file: string; bytes: number }>;
  skipped: Array<{ id: string; reason: string }>;
  warnings: string[];
  /** Earlier ADE proof comments deleted by `replace`. */
  replaced?: number;
};

/** The last line of every proof comment ADE posts; `replace` finds earlier ones by it. */
const PROOF_COMMENT_FOOTER = "<sub>Posted by ADE from the chat's proof.</sub>";

/** How long each `gh` call may run. An upload of up to 100 MB gets the longest. */
export const GH_TIMEOUTS_MS = { quick: 30_000, upload: 10 * 60_000 } as const;

export class ProofPublishError extends Error {}

/** The reason a `gh` call failed, in one line, including a timeout. */
function ghFailure(result: ReturnType<typeof spawnSync>, fallback: string): string {
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") return "gh did not finish in time";
  return String(result.stderr ?? "").trim() || fallback;
}

/** Refuses with a plain instruction when `gh` is missing or too old for `--attach`. */
export function assertGhSupportsAttach(run: typeof spawnSync = spawnSync): void {
  const result = run("gh", ["--version"], { encoding: "utf8", timeout: GH_TIMEOUTS_MS.quick });
  if (result.error || result.status !== 0) {
    throw new ProofPublishError("GitHub CLI (gh) is not installed. Install gh 2.99.0 or later, then run gh auth login.");
  }
  const version = parseGhVersion(String(result.stdout ?? ""));
  if (!ghVersionCanAttach(version)) {
    throw new ProofPublishError(
      `gh ${version?.join(".") ?? "(unknown version)"} cannot attach files. Upgrade to gh 2.99.0 or later (brew upgrade gh), then run this again.`,
    );
  }
}

/**
 * Posts the artifacts to the PR as one comment and returns what went up and
 * what was left out, with the reason. Throws when nothing could be posted or
 * `gh` failed.
 */
export function publishProofToPullRequest(args: {
  pr: string;
  projectRoot: string;
  artifacts: PublishableArtifact[];
  heading?: string | null;
  note?: string | null;
  /** Delete this account's earlier ADE proof comments on the PR, after the new one posts. */
  replace?: boolean;
  cwd?: string;
  run?: typeof spawnSync;
}): ProofPublishResult {
  const run = args.run ?? spawnSync;
  assertGhSupportsAttach(run);

  const view = run("gh", ["pr", "view", args.pr, "--json", "url", "--jq", ".url"], {
    encoding: "utf8",
    cwd: args.cwd,
    timeout: GH_TIMEOUTS_MS.quick,
  });
  const prUrl = String(view.stdout ?? "").trim();
  if (view.status !== 0 || !/\/pull\/\d+$/.test(prUrl)) {
    throw new ProofPublishError(`gh could not find pull request ${args.pr}: ${ghFailure(view, "no URL returned")}`);
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-proof-publish-"));
  const posted: ProofPublishResult["posted"] = [];
  const skipped: ProofPublishResult["skipped"] = [];
  const warnings: string[] = [];
  const lines: string[] = [`## ${args.heading?.trim() || "Proof"}`, ""];
  if (args.note?.trim()) lines.push(args.note.trim(), "");
  const attachArgs: string[] = [];
  try {
    for (const artifact of args.artifacts) {
      const staged = stageProofFile(artifact, args.projectRoot, staging, posted.length + 1);
      if ("skip" in staged) {
        skipped.push({ id: artifact.id, reason: staged.skip });
        continue;
      }
      if (staged.warning) warnings.push(staged.warning);
      const { file, bytes, caption } = staged;
      posted.push({ id: artifact.id, caption, file, bytes });
      lines.push(`![${caption}](./${file})`, "", caption, "");
      attachArgs.push("--attach", `./${file}`);
    }
    if (!posted.length) {
      throw new ProofPublishError(
        `nothing to post: ${skipped.map((entry) => `${entry.id} (${entry.reason})`).join("; ") || "no artifacts"}`,
      );
    }
    lines.push(PROOF_COMMENT_FOOTER);
    fs.writeFileSync(path.join(staging, "body.md"), lines.join("\n"));
    // Run from the staging directory: gh resolves `./proof-N.ext` against it.
    const comment = run("gh", ["pr", "comment", prUrl, "--body-file", "body.md", ...attachArgs], {
      encoding: "utf8",
      cwd: staging,
      timeout: GH_TIMEOUTS_MS.upload,
    });
    if (comment.status !== 0) {
      throw new ProofPublishError(`gh pr comment failed: ${ghFailure(comment, `exit ${comment.status}`)}`);
    }
    const commentUrl = /https:\/\/\S+#issuecomment-\d+/.exec(String(comment.stdout ?? ""))?.[0] ?? null;
    const replaced = args.replace ? deleteEarlierProofComments({ run, prUrl, keepUrl: commentUrl, cwd: args.cwd, warnings }) : undefined;
    return { prUrl, commentUrl, posted, skipped, warnings, ...(replaced !== undefined ? { replaced } : {}) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Deletes the signed-in account's earlier ADE proof comments on the PR (found
 * by {@link PROOF_COMMENT_FOOTER}), never `keepUrl`, the one just posted.
 * Runs after the new comment is up, so a failed post leaves the old proof in
 * place. A failure here is a warning: the new proof is already posted.
 */
function deleteEarlierProofComments(args: {
  run: typeof spawnSync;
  prUrl: string;
  keepUrl: string | null;
  cwd?: string;
  warnings: string[];
}): number {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(args.prUrl);
  const keepId = /#issuecomment-(\d+)$/.exec(args.keepUrl ?? "")?.[1] ?? null;
  if (!match || !keepId) {
    args.warnings.push("Could not tell which comment was just posted, so earlier proof comments were left in place.");
    return 0;
  }
  const [, owner, repo, number] = match;
  const login = args.run("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", cwd: args.cwd, timeout: GH_TIMEOUTS_MS.quick });
  const me = String(login.stdout ?? "").trim();
  if (login.status !== 0 || !me) {
    args.warnings.push(`Earlier proof comments were left in place: ${ghFailure(login, "gh could not read the signed-in account")}.`);
    return 0;
  }
  const list = args.run(
    "gh",
    ["api", "--paginate", `repos/${owner}/${repo}/issues/${number}/comments`, "--jq", `.[] | [.id, .user.login, (.body | contains(${JSON.stringify(PROOF_COMMENT_FOOTER)}))] | @tsv`],
    { encoding: "utf8", cwd: args.cwd, timeout: GH_TIMEOUTS_MS.upload },
  );
  if (list.status !== 0) {
    args.warnings.push(`Earlier proof comments were left in place: ${ghFailure(list, "gh could not list the PR's comments")}.`);
    return 0;
  }
  let deleted = 0;
  for (const row of String(list.stdout ?? "").split("\n")) {
    const [id, author, ours] = row.trim().split("\t");
    if (!id || id === keepId || author !== me || ours !== "true") continue;
    const removal = args.run("gh", ["api", "-X", "DELETE", `repos/${owner}/${repo}/issues/comments/${id}`], {
      encoding: "utf8",
      cwd: args.cwd,
      timeout: GH_TIMEOUTS_MS.quick,
    });
    if (removal.status === 0) deleted += 1;
    else args.warnings.push(`Could not delete earlier proof comment ${id}: ${ghFailure(removal, `exit ${removal.status}`)}.`);
  }
  return deleted;
}

/**
 * Uploads the proof a pull request's text cites and rewrites each citation in
 * place, so GitHub shows the picture beside the claim it proves.
 *
 * The text is read from GitHub, not taken from the caller: ADE adds its own
 * link block to a description after the PR is made, and a `--body-file` edit
 * replaces the whole text. An item that cannot go up keeps its citation, which
 * ADE still shows. Throws when the text cites nothing that could be uploaded.
 */
export function publishProofIntoPullRequestBody(args: {
  pr: string;
  projectRoot: string;
  artifacts: PublishableArtifact[];
  cwd?: string;
  run?: typeof spawnSync;
}): ProofPublishResult {
  const run = args.run ?? spawnSync;
  assertGhSupportsAttach(run);
  const { url: prUrl, body } = readPullRequestBody(args.pr, { cwd: args.cwd, run });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-proof-publish-"));
  try {
    const { rewritten, posted, skipped, warnings } = stagePrBodyProof({ body, artifacts: args.artifacts, projectRoot: args.projectRoot, staging });
    if (!posted.length) {
      throw new ProofPublishError(
        `nothing to upload: ${skipped.map((entry) => `${entry.id} (${entry.reason})`).join("; ") || "the PR text cites no proof"}`,
      );
    }
    fs.writeFileSync(path.join(staging, "body.md"), rewritten);
    const edit = run(
      "gh",
      ["pr", "edit", prUrl, "--body-file", "body.md", ...posted.flatMap((entry) => ["--attach", `./${entry.file}`])],
      { encoding: "utf8", cwd: staging, timeout: GH_TIMEOUTS_MS.upload },
    );
    if (edit.status !== 0) {
      throw new ProofPublishError(`gh pr edit failed: ${ghFailure(edit, `exit ${edit.status}`)}`);
    }
    return { prUrl, commentUrl: null, posted, skipped, warnings };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** The PR's URL and its text as GitHub holds them now. */
export function readPullRequestBody(pr: string, options: { cwd?: string; run?: typeof spawnSync } = {}): { url: string; body: string } {
  const run = options.run ?? spawnSync;
  const view = run("gh", ["pr", "view", pr, "--json", "url,body"], {
    encoding: "utf8",
    cwd: options.cwd,
    timeout: GH_TIMEOUTS_MS.quick,
  });
  let parsed: { url?: unknown; body?: unknown } = {};
  try {
    parsed = JSON.parse(String(view.stdout ?? "")) as typeof parsed;
  } catch {
    // Reported below with gh's own words.
  }
  const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
  if (view.status !== 0 || !/\/pull\/\d+$/.test(url)) {
    throw new ProofPublishError(`gh could not find pull request ${pr}: ${ghFailure(view, "no URL returned")}`);
  }
  return { url, body: typeof parsed.body === "string" ? parsed.body : "" };
}

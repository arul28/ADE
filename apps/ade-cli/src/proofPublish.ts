/**
 * `ade proof publish`: posts chosen proof to a GitHub pull request as one
 * comment, through `gh pr comment --attach`.
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

/** `gh pr comment --attach` shipped in 2.99.0. */
export const GH_ATTACH_MIN_VERSION = [2, 99, 0] as const;

/** GitHub's upload limits for an attachment. */
export const GITHUB_ATTACHMENT_LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  /** Free plans. Paid plans allow {@link GITHUB_ATTACHMENT_LIMITS.videoPaidBytes}. */
  videoFreeBytes: 10 * 1024 * 1024,
  videoPaidBytes: 100 * 1024 * 1024,
} as const;

export type PublishableArtifact = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  uri: string;
  mimeType: string | null;
};

export type ProofPublishResult = {
  prUrl: string;
  commentUrl: string | null;
  posted: Array<{ id: string; caption: string; file: string; bytes: number }>;
  skipped: Array<{ id: string; reason: string }>;
  warnings: string[];
};

/** How long each `gh` call may run. An upload of up to 100 MB gets the longest. */
export const GH_TIMEOUTS_MS = { quick: 30_000, upload: 10 * 60_000 } as const;

export class ProofPublishError extends Error {}

/** The reason a `gh` call failed, in one line, including a timeout. */
function ghFailure(result: ReturnType<typeof spawnSync>, fallback: string): string {
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") return "gh did not finish in time";
  return String(result.stderr ?? "").trim() || fallback;
}

function parseVersion(text: string): number[] | null {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match.slice(1, 4).map(Number) : null;
}

function versionAtLeast(version: number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const have = version[index] ?? 0;
    const need = minimum[index] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

/** Refuses with a plain instruction when `gh` is missing or too old for `--attach`. */
export function assertGhSupportsAttach(run: typeof spawnSync = spawnSync): void {
  const result = run("gh", ["--version"], { encoding: "utf8", timeout: GH_TIMEOUTS_MS.quick });
  if (result.error || result.status !== 0) {
    throw new ProofPublishError("GitHub CLI (gh) is not installed. Install gh 2.99.0 or later, then run gh auth login.");
  }
  const version = parseVersion(String(result.stdout ?? ""));
  if (!version || !versionAtLeast(version, GH_ATTACH_MIN_VERSION)) {
    throw new ProofPublishError(
      `gh ${version?.join(".") ?? "(unknown version)"} cannot attach files. Upgrade to gh 2.99.0 or later (brew upgrade gh), then run this again.`,
    );
  }
}

function isVideo(artifact: PublishableArtifact): boolean {
  return artifact.kind === "video_recording" || (artifact.mimeType?.startsWith("video/") ?? false);
}

function isPicture(artifact: PublishableArtifact): boolean {
  return artifact.kind === "screenshot" || (artifact.mimeType?.startsWith("image/") ?? false);
}

/** Brackets and line breaks would end the markdown alt text early. */
function markdownCaption(text: string): string {
  return text.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The stored file for a proof record, inside the project's artifact store
 * only. Both sides are resolved through symlinks first: the file goes to
 * GitHub, so a link inside the store must not reach a file outside it.
 */
export function resolveStoredProofFile(projectRoot: string, uri: string): string | null {
  if (!uri || /^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return null;
  let artifactsDir: string;
  let candidate: string;
  try {
    artifactsDir = fs.realpathSync.native(path.resolve(projectRoot, ".ade", "artifacts"));
    candidate = fs.realpathSync.native(path.resolve(projectRoot, uri));
  } catch {
    return null;
  }
  const relative = path.relative(artifactsDir, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return fs.statSync(candidate).isFile() ? candidate : null;
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
      if (!isPicture(artifact) && !isVideo(artifact)) {
        skipped.push({ id: artifact.id, reason: `a ${artifact.kind.replace(/_/g, " ")} cannot be attached to a PR` });
        continue;
      }
      const source = resolveStoredProofFile(args.projectRoot, artifact.uri);
      if (!source) {
        // The list comes from the brain; the file must be on this machine too.
        // A brain on another machine keeps its proof there, so run the command
        // on that machine (where its agents run) to post it.
        skipped.push({
          id: artifact.id,
          reason: `its stored file is not on this machine under ${path.join(args.projectRoot, ".ade", "artifacts")}; if the ADE brain runs on another machine, run this command there`,
        });
        continue;
      }
      const bytes = fs.statSync(source).size;
      const limit = isVideo(artifact) ? GITHUB_ATTACHMENT_LIMITS.videoPaidBytes : GITHUB_ATTACHMENT_LIMITS.imageBytes;
      if (bytes > limit) {
        skipped.push({
          id: artifact.id,
          reason: `it is ${(bytes / 1024 / 1024).toFixed(1)} MB, over GitHub's ${limit / 1024 / 1024} MB limit for ${isVideo(artifact) ? "a video" : "a picture"}`,
        });
        continue;
      }
      if (isVideo(artifact) && bytes > GITHUB_ATTACHMENT_LIMITS.videoFreeBytes) {
        warnings.push(`${artifact.id} is ${(bytes / 1024 / 1024).toFixed(1)} MB. GitHub Free accepts videos up to 10 MB; paid plans up to 100 MB.`);
      }
      // A plain, unique name: gh matches body references by path.
      const file = `proof-${posted.length + 1}${path.extname(source).toLowerCase() || (isVideo(artifact) ? ".mp4" : ".png")}`;
      fs.copyFileSync(source, path.join(staging, file));
      const caption = markdownCaption(artifact.description?.trim() || artifact.title || file);
      posted.push({ id: artifact.id, caption, file, bytes });
      lines.push(`![${caption}](./${file})`, "", caption, "");
      attachArgs.push("--attach", `./${file}`);
    }
    if (!posted.length) {
      throw new ProofPublishError(
        `nothing to post: ${skipped.map((entry) => `${entry.id} (${entry.reason})`).join("; ") || "no artifacts"}`,
      );
    }
    lines.push("<sub>Posted by ADE from the chat's proof.</sub>");
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
    return { prUrl, commentUrl, posted, skipped, warnings };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

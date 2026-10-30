/**
 * Getting cited proof ready for a pull request's text: each cited proof file is
 * copied into a staging directory, and each citation is rewritten to the
 * `./file` reference `gh pr edit --attach` swaps for the uploaded copy.
 *
 * `ade proof publish --in-body` and the brain's repair of a body an agent wrote
 * with `gh` both use this, so the two put proof on GitHub the same way. Only an
 * `ade-proof://` citation or a ```proof-compare block whose proof is in the
 * list goes up; the rest of the text is left as written.
 */

import fs from "node:fs";
import path from "node:path";

import { prBodyProofIds, rewritePrBodyProofForGithub, type PrBodyProofFile } from "../../../shared/prBodyProof";

/** `gh pr comment --attach` and `gh pr edit --attach` shipped in 2.99.0. */
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

export type StagedProofEntry = { id: string; caption: string; file: string; bytes: number };

/** The version `gh --version` printed, or null when it printed none. */
export function parseGhVersion(text: string): number[] | null {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Whether that version can attach files. */
export function ghVersionCanAttach(version: number[] | null): boolean {
  if (!version) return false;
  for (let index = 0; index < GH_ATTACH_MIN_VERSION.length; index += 1) {
    const have = version[index] ?? 0;
    const need = GH_ATTACH_MIN_VERSION[index] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
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

export type StagedProofFile =
  | { file: string; bytes: number; caption: string; video: boolean; warning: string | null }
  | { skip: string };

/**
 * Copies one proof file into the staging directory under a plain, unique name
 * (gh matches body references by path), or says why it cannot go up.
 */
export function stageProofFile(artifact: PublishableArtifact, projectRoot: string, staging: string, ordinal: number): StagedProofFile {
  if (!isPicture(artifact) && !isVideo(artifact)) {
    return { skip: `a ${artifact.kind.replace(/_/g, " ")} cannot be attached to a PR` };
  }
  const source = resolveStoredProofFile(projectRoot, artifact.uri);
  if (!source) {
    // The list comes from the brain; the file must be on this machine too.
    // A brain on another machine keeps its proof there, so run the command
    // on that machine (where its agents run) to post it.
    return {
      skip: `its stored file is not on this machine under ${path.join(projectRoot, ".ade", "artifacts")}; if the ADE brain runs on another machine, run this command there`,
    };
  }
  const video = isVideo(artifact);
  const bytes = fs.statSync(source).size;
  const limit = video ? GITHUB_ATTACHMENT_LIMITS.videoPaidBytes : GITHUB_ATTACHMENT_LIMITS.imageBytes;
  if (bytes > limit) {
    return {
      skip: `it is ${(bytes / 1024 / 1024).toFixed(1)} MB, over GitHub's ${limit / 1024 / 1024} MB limit for ${video ? "a video" : "a picture"}`,
    };
  }
  const file = `proof-${ordinal}${path.extname(source).toLowerCase() || (video ? ".mp4" : ".png")}`;
  fs.copyFileSync(source, path.join(staging, file));
  return {
    file,
    bytes,
    caption: markdownCaption(artifact.description?.trim() || artifact.title || file),
    video,
    warning: video && bytes > GITHUB_ATTACHMENT_LIMITS.videoFreeBytes
      ? `${artifact.id} is ${(bytes / 1024 / 1024).toFixed(1)} MB. GitHub Free accepts videos up to 10 MB; paid plans up to 100 MB.`
      : null,
  };
}

/**
 * Stages the proof `body` cites and returns the text with those citations
 * rewritten to `./file` references. `artifacts` is the proof the caller may
 * publish; a citation of anything else stays as written and is reported in
 * `skipped`. `posted` is empty when nothing could go up, and then `rewritten`
 * is `body` unchanged.
 */
export function stagePrBodyProof(args: {
  body: string;
  artifacts: PublishableArtifact[];
  projectRoot: string;
  staging: string;
}): { rewritten: string; posted: StagedProofEntry[]; skipped: Array<{ id: string; reason: string }>; warnings: string[] } {
  const cited = new Set(prBodyProofIds(args.body));
  const posted: StagedProofEntry[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const warnings: string[] = [];
  const files = new Map<string, PrBodyProofFile>();
  for (const artifact of args.artifacts) {
    if (!cited.has(artifact.id) || files.has(artifact.id)) continue;
    const staged = stageProofFile(artifact, args.projectRoot, args.staging, posted.length + 1);
    if ("skip" in staged) {
      skipped.push({ id: artifact.id, reason: staged.skip });
      continue;
    }
    if (staged.warning) warnings.push(staged.warning);
    files.set(artifact.id, { file: staged.file, video: staged.video });
    posted.push({ id: artifact.id, caption: staged.caption, file: staged.file, bytes: staged.bytes });
  }
  for (const id of cited) {
    if (!files.has(id) && !skipped.some((entry) => entry.id === id)) {
      skipped.push({ id, reason: "not in this chat's or lane's proof" });
    }
  }
  if (!posted.length) return { rewritten: args.body, posted, skipped, warnings };
  const rewritten = rewritePrBodyProofForGithub(args.body, (id) => files.get(id) ?? null);
  // A comparison goes up whole or stays as written. A side staged for a pair
  // whose other side could not go up is in no sentence of the new text, so
  // it is not attached and not reported as uploaded.
  for (const entry of [...posted]) {
    if (rewritten.includes(`](./${entry.file})`)) continue;
    posted.splice(posted.indexOf(entry), 1);
    skipped.push({ id: entry.id, reason: "the other side of its comparison could not be uploaded" });
  }
  // An item cited two times can go up for one citation and stay behind in a
  // comparison. It is uploaded, so it is not skipped; say what stayed.
  const stillCited = new Set(prBodyProofIds(rewritten));
  for (const entry of posted) {
    if (stillCited.has(entry.id)) warnings.push(`${entry.id} is uploaded, but it also stays as a citation in a comparison whose other side could not be uploaded`);
  }
  return { rewritten: posted.length ? rewritten : args.body, posted, skipped, warnings };
}

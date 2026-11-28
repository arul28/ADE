/**
 * Before push-work pushes a lane (a free, a downgrade, `ade cloud push-work`),
 * nobody reads what it sends. So ADE reads it first: the changes it is about
 * to commit (staged into a copy of the index, so the lane's own index and any
 * merge in progress stay as they are) and every commit no remote has yet. When
 * an added line looks like a key or a password, or a key file is added, the
 * lane is not committed or pushed, and the computer stays. After its commit,
 * which runs the repository's hooks, the commit is read once more.
 *
 * It catches, in added lines only (a merge's own: its conflict resolutions and
 * what it adds beyond both parents):
 * - a value of one of this project's ADE secrets, 8 characters or longer,
 *   as written or base64-, base64url- or URL-encoded (`maskSecretValues`);
 * - a token with a known shape (`TOKEN_SHAPES`);
 * - a file added (or renamed) under a key file's name (`.env`, `.env.local`,
 *   `id_rsa`, a `.p12`), whatever it holds, empty too.
 * It can't see a secret in any other form (split, reversed, encrypted, inside
 * a binary or an archive), a password with no known shape, or a value of a
 * secret ADE doesn't hold. A file git ignores is never pushed, so it is never read.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../../../../desktop/src/main/services/git/git";
import { maskSecretValues } from "../../../../desktop/src/main/services/secrets/secretExec";

/** One git read (a few per lane, inside the free's 4 minutes); a read that can't finish keeps the work on the computer, unpushed. */
const READ_TIMEOUT_MS = 30_000;
const READ_MAX_BYTES = 64 * 1024 * 1024;
/** Files named in the answer; the rest are counted. */
const MAX_FILES_NAMED = 5;

/** Credentials on sight: each is long and prefixed, so ordinary code doesn't match. */
const TOKEN_SHAPES: ReadonlyArray<RegExp> = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{60,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS access key id
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/, // PEM, OpenSSH, PGP
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/, // Stripe, Clerk
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/, // Slack
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, // OpenAI
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google
  /\bnpm_[A-Za-z0-9]{36}\b/,
];

/** `.env` and `.env.<anything>` but the usual templates, ssh keys, `.netrc`, certificate bundles with their key. */
const KEY_FILE = /(?:^|\/)(?:\.env(?:\.(?!(?:example|sample|template|dist|defaults?|schema)$)[^/]+)?|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:p12|pfx))$/i;

export type PushSecretCheck =
  | { ok: true }
  /** `files`: where it was found (at most `MAX_FILES_NAMED`); `more` counts the rest. */
  | { ok: false; found: true; files: string[]; more: number }
  | { ok: false; found: false; error: string };

/** A path as git's patch header writes it: `b/` first, quoted when unusual, a tab after it when it has a space. */
const pathIn = (header: string): string => {
  const raw = header.replace(/\t$/, "");
  const unquoted = raw.startsWith("\"") && raw.endsWith("\"") ? raw.slice(1, -1) : raw;
  return unquoted.replace(/^[ab]\//, "");
};

/**
 * The files a patch adds a secret to, from its added lines. A merge's combined
 * diff (`--cc`) marks a line added against every parent with one `+` per
 * parent: only those are the merge's own.
 */
function filesWithSecretLines(patch: string, values: readonly string[]): Set<string> {
  const added = new Map<string, string[]>();
  let file = "";
  let parents = 1;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      file = "";
      inHunk = false;
    } else if (inHunk && !line.startsWith("@@")) {
      if (file && line.startsWith("+".repeat(parents))) {
        const lines = added.get(file) ?? [];
        lines.push(line.slice(parents));
        added.set(file, lines);
      }
    } else if (line.startsWith("+++ ") && !inHunk) {
      file = pathIn(line.slice(4));
    } else if (line.startsWith("@@")) {
      inHunk = true;
      parents = Math.max(1, (/^@+/.exec(line)?.[0].length ?? 2) - 1);
    }
  }
  const found = new Set<string>();
  for (const [file, lines] of added) {
    const text = lines.join("\n");
    if (TOKEN_SHAPES.some((shape) => shape.test(text)) || (values.length > 0 && maskSecretValues(text, values) !== text)) found.add(file);
  }
  return found;
}

/** The key-file names in a NUL-separated list of added paths (`--name-only -z --diff-filter=A --no-renames`). */
const keyFilesIn = (names: string): string[] => names.split("\0").map((name) => name.replace(/^\n+/, "")).filter((name) => name && KEY_FILE.test(name));

type Read = string | { error: string };

/**
 * Reads what a push of the lane at `cwd` would send. `unpushed`: every commit
 * on HEAD no remote has; `uncommitted`: those and the lane's changes, as
 * `git add -A` would stage them; `lastCommit`: only HEAD's commit (push-work's
 * own, read again after its hooks ran).
 */
export async function checkPushForSecrets(cwd: string, secretValues: readonly string[], what: "uncommitted" | "unpushed" | "lastCommit"): Promise<PushSecretCheck> {
  if (!cwd) return { ok: false, found: false, error: "ADE couldn't find the lane's folder." };
  const read = async (args: string[], env?: NodeJS.ProcessEnv): Promise<Read> => {
    const result = await runGit(["-c", "core.quotePath=false", ...args], { cwd, timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: READ_MAX_BYTES, ...(env ? { env } : {}) });
    if (result.stdoutTruncated) return { error: "too much to read" };
    if (result.exitCode === 0) return result.stdout;
    if (result.timedOut) return { error: "timed out" };
    return { error: result.stderr.trim().split(/\r?\n/, 1)[0] || `exit ${result.exitCode}` };
  };
  const patchArgs = ["--no-color", "--no-ext-diff", "--no-textconv", "-U0"];
  const addedArgs = ["--name-only", "-z", "--no-renames", "--diff-filter=A"];
  const patches: string[] = [];
  const names: string[] = [];
  const failed = (part: string, refused: { error: string }): PushSecretCheck => ({ ok: false, found: false, error: `ADE couldn't read the ${part} to push (${refused.error}).` });

  if (what === "uncommitted") {
    // Staged into a copy of the index: the lane's own index (what the person
    // staged, a merge in progress) stays as it is when the push stops here.
    const indexPath = await read(["rev-parse", "--git-path", "index"]);
    if (typeof indexPath !== "string") return failed("changes", indexPath);
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ade-push-check-"));
    try {
      const index = path.join(scratch, "index");
      await fs.copyFile(path.resolve(cwd, indexPath.trim()), index).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const env = { GIT_INDEX_FILE: index };
      const staged = await read(["-c", "core.sparseCheckout=false", "add", "-A", "--", "."], env);
      if (typeof staged !== "string") return failed("changes", staged);
      for (const args of [["diff", "--cached", ...patchArgs], ["diff", "--cached", ...addedArgs]]) {
        const out = await read(args, env);
        if (typeof out !== "string") return failed("changes", out);
        (args.includes("-z") ? names : patches).push(out);
      }
    } finally {
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const range = what === "lastCommit" ? ["-1", "HEAD"] : ["HEAD", "--not", "--remotes"];
  const history = [["log", "-p", "--cc", "--format=%H", ...patchArgs, ...range], ["log", "--cc", "--format=", ...addedArgs, ...range]];
  for (const args of history) {
    const out = await read(args);
    if (typeof out === "string") {
      (args.includes("-z") ? names : patches).push(out);
      continue;
    }
    // A lane with no commit yet has no history to push.
    const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, timeoutMs: READ_TIMEOUT_MS });
    if (head.exitCode !== 1) return failed("commits", out);
  }

  const values = secretValues.filter(Boolean);
  const files = [...new Set([...names.flatMap(keyFilesIn), ...patches.flatMap((patch) => [...filesWithSecretLines(patch, values)])])].sort();
  if (files.length === 0) return { ok: true };
  return { ok: false, found: true, files: files.slice(0, MAX_FILES_NAMED), more: Math.max(0, files.length - MAX_FILES_NAMED) };
}

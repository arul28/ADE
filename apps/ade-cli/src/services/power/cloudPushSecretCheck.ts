/**
 * Before push-work pushes a lane (a free, a downgrade, `ade cloud push-work`),
 * nobody reads what it sends. So ADE reads it first: the changes it is about
 * to commit and every commit no remote has yet. When an added line looks like
 * a key or a password, or a key file is added, the lane is not committed or
 * pushed, and the computer stays.
 *
 * It catches, in added lines only:
 * - a value of one of this project's ADE secrets, 8 characters or longer,
 *   as written or base64-, base64url- or URL-encoded (`maskSecretValues`);
 * - a token with a known shape (`TOKEN_SHAPES`);
 * - a new file named like a key file (`.env`, `.env.local`, `id_rsa`, a
 *   `.p12`), whatever it holds.
 * It can't see a secret in any other form (split, reversed, encrypted, inside
 * a binary or an archive), a password with no known shape, or a value of a
 * secret ADE doesn't hold. A file git ignores is never pushed, so it is never read.
 */

import { runGit } from "../../../../desktop/src/main/services/git/git";
import { maskSecretValues } from "../../../../desktop/src/main/services/secrets/secretExec";

/** One read (two per lane, inside the free's 4 minutes); a read that can't finish keeps the work on the computer, unpushed. */
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

/** The files a patch adds a secret to, from its added lines and the files it creates. */
function filesWithSecrets(patch: string, values: readonly string[]): Set<string> {
  const found = new Set<string>();
  const added = new Map<string, string[]>();
  let file = "";
  let created = false;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = "";
      created = false;
      inHunk = false;
    } else if (inHunk) {
      if (line.startsWith("+") && file) {
        const lines = added.get(file) ?? [];
        lines.push(line.slice(1));
        added.set(file, lines);
      }
    } else if (line.startsWith("new file mode")) {
      created = true;
    } else if (line.startsWith("+++ ")) {
      file = pathIn(line.slice(4));
      if (created && KEY_FILE.test(file)) found.add(file);
    } else if (line.startsWith("Binary files /dev/null and ")) {
      const binary = pathIn(line.slice("Binary files /dev/null and ".length).replace(/ differ$/, ""));
      if (KEY_FILE.test(binary)) found.add(binary);
    } else if (line.startsWith("@@")) {
      inHunk = true;
    }
  }
  for (const [path, lines] of added) {
    if (found.has(path)) continue;
    const text = lines.join("\n");
    if (TOKEN_SHAPES.some((shape) => shape.test(text)) || (values.length > 0 && maskSecretValues(text, values) !== text)) found.add(path);
  }
  return found;
}

/**
 * Reads what a push of the lane at `cwd` would send: the staged changes
 * (push-work stages everything first) and the commits on HEAD no remote has.
 */
export async function checkPushForSecrets(cwd: string, secretValues: readonly string[]): Promise<PushSecretCheck> {
  if (!cwd) return { ok: false, found: false, error: "ADE couldn't find the lane's folder." };
  const read = async (args: string[]): Promise<string | { error: string }> => {
    const result = await runGit(["-c", "core.quotePath=false", ...args], { cwd, timeoutMs: READ_TIMEOUT_MS, maxOutputBytes: READ_MAX_BYTES });
    if (result.stdoutTruncated) return { error: "too much to read" };
    if (result.exitCode === 0) return result.stdout;
    if (result.timedOut) return { error: "timed out" };
    return { error: result.stderr.trim().split(/\r?\n/, 1)[0] || `exit ${result.exitCode}` };
  };
  const patchArgs = ["--no-color", "--no-ext-diff", "--no-textconv", "-U0"];
  const staged = await read(["diff", "--cached", ...patchArgs]);
  if (typeof staged !== "string") return { ok: false, found: false, error: `ADE couldn't read the changes to push (${staged.error}).` };
  let history = await read(["log", "-p", "--format=%H", ...patchArgs, "HEAD", "--not", "--remotes"]);
  if (typeof history !== "string") {
    // A lane with no commit yet has no history to push.
    const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, timeoutMs: READ_TIMEOUT_MS });
    if (head.exitCode !== 1) return { ok: false, found: false, error: `ADE couldn't read the commits to push (${history.error}).` };
    history = "";
  }
  const values = secretValues.filter(Boolean);
  const files = [...new Set([...filesWithSecrets(staged, values), ...filesWithSecrets(history, values)])].sort();
  if (files.length === 0) return { ok: true };
  return { ok: false, found: true, files: files.slice(0, MAX_FILES_NAMED), more: Math.max(0, files.length - MAX_FILES_NAMED) };
}

/**
 * `ade git credential <get|store|erase>`: a git credential helper that answers
 * with ADE's GitHub token for https://github.com, read when git asks
 * (environment, then `gh`, then the token saved in ADE), never stored.
 *
 * Only a clone made on an ADE Cloud computer records it, in that clone's
 * local config (`projectScaffoldService.ts`), so a plain `git push` in a
 * terminal there signs in while no token sits in `.git/config`. On a
 * person's own computer no helper is recorded: ADE's own fetch and push pass
 * the token per command, and the person's own git setup works as in any
 * repository.
 *
 * The recorded entries are an empty `credential.https://github.com.helper`
 * first, which resets the list, then ADE's: git sends `store` to every helper
 * after a request succeeds, so a system or global helper (the image's, a
 * Keychain, Git Credential Manager) would otherwise save ADE's token for
 * every github.com repository. The helper names the launcher by an absolute,
 * sh-quoted path (git runs `!` helpers through `sh`), never a bare `ade`
 * that a terminal's PATH may not have.
 *
 * Git's protocol: key=value lines on stdin ending with a blank line; for
 * `get`, answer `username=` and `password=` lines, or nothing to let git try
 * its next helper. `store` and `erase` are ignored: ADE owns the token.
 */
import fs from "node:fs";
import path from "node:path";

export const ADE_GIT_CREDENTIAL_HELPER_KEY = "credential.https://github.com.helper";

/**
 * The launcher an ADE Cloud computer's clone records. First the ADE this
 * brain runs: the entrypoint starts the newer of the image's ADE and the ADE
 * home's (`pick_ade`), so `process.execPath` is the one that knows
 * `ade git credential`. Then the ADE home's `bin/ade` (`ade brain update`),
 * and last the image's `/usr/local/bin/ade`, which can be older. Null when
 * none is an executable file; then no helper is recorded.
 */
export function cloudAdeLauncherPath(
  adeHome: string,
  isExecutable: (file: string) => boolean = isExecutableFile,
  runningExecutable: string = process.execPath,
): string | null {
  const running = path.posix.basename(runningExecutable) === "ade" ? runningExecutable : null;
  for (const candidate of [running, path.posix.join(adeHome, "bin", "ade"), "/usr/local/bin/ade"]) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The helper value for a launcher: `!'<path>' git credential`, quoted for `sh`. */
export function adeGitCredentialHelperValue(launcher: string): string {
  return `!'${launcher.replace(/'/g, `'\\''`)}' git credential`;
}

function parseGitCredentialRequest(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line) break;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

/** The answer for one request: the token for GitHub over https, else nothing. */
function gitCredentialAnswer(fields: Record<string, string>, token: string | null): string {
  if (!token) return "";
  if ((fields.protocol ?? "https") !== "https") return "";
  const host = (fields.host ?? "").toLowerCase();
  if (host !== "github.com") return "";
  return `username=x-access-token\npassword=${token}\n`;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    if (/\n\r?\n/.test(text)) break;
  }
  return text;
}

/** Writes and waits until the stream took it, so the process can exit right after. */
function writeAndFlush(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

/**
 * One line for git's output (git shows a helper's stderr). Only an error
 * code, never the error's message: a parse error can quote what it read.
 */
function failureLine(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const why = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
  return `ade git credential: ADE has no GitHub sign-in it can use on this computer${why}. Connect GitHub in ADE's Settings › GitHub.\n`;
}

export async function runGitCredentialHelper(
  operation: string | undefined,
  deps: {
    /** ADE's GitHub token; throws when it has none or can't read it. */
    readToken: () => Promise<string | null>;
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  },
): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const request = await readAll(stdin);
  if (operation !== "get") return 0;
  let token: string | null;
  try {
    token = await deps.readToken();
  } catch (error) {
    // Nothing for git: it tries its next helper, or says it couldn't sign in, after this line.
    await writeAndFlush(stderr, failureLine(error));
    return 0;
  }
  const answer = gitCredentialAnswer(parseGitCredentialRequest(request), token);
  if (answer) await writeAndFlush(stdout, answer);
  return 0;
}

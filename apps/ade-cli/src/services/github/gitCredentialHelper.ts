/**
 * `ade git credential <get|store|erase>`: a git credential helper that answers
 * with ADE's GitHub token for https://github.com, read when git asks
 * (environment, then `gh`, then the token saved in ADE), never stored.
 *
 * A clone ADE makes with its token records this helper in the clone's
 * config (`credential.https://github.com.helper`), so a plain `git push` in a
 * terminal there still signs in, while no token sits in `.git/config`.
 *
 * Git's protocol: key=value lines on stdin ending with a blank line; for
 * `get`, answer `username=` and `password=` lines, or nothing to let git try
 * its next helper. `store` and `erase` are ignored: ADE owns the token.
 */

/** The helper value ADE writes into a clone's config. */
export const ADE_GIT_CREDENTIAL_HELPER = "!ade git credential";
export const ADE_GIT_CREDENTIAL_HELPER_KEY = "credential.https://github.com.helper";

export function parseGitCredentialRequest(text: string): Record<string, string> {
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
export function gitCredentialAnswer(fields: Record<string, string>, token: string | null): string {
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

export async function runGitCredentialHelper(
  operation: string | undefined,
  deps: {
    readToken: () => Promise<string | null>;
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
  },
): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const request = await readAll(stdin).catch(() => "");
  if (operation !== "get") return 0;
  const token = await deps.readToken().catch(() => null);
  const answer = gitCredentialAnswer(parseGitCredentialRequest(request), token);
  if (answer) stdout.write(answer);
  return 0;
}

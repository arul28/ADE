import {
  CLOUD_REMOTE_SIGN_IN_ELSEWHERE,
  cloudRemoteSignInOf,
  type CloudRemoteSignInStart,
  type CloudRemoteSignInState,
  type CloudRemoteSignInStatus,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { commandWith, readResult } from "./planCleanup";
import type { CloudProvider } from "./provider";
import type { ComputerRow } from "./store";

/**
 * Provider sign-ins on a cloud computer from a phone or the web (C8). The
 * server runs the computer's own command through the provider's exec, each a
 * short call: the command starts the provider's own sign-in in the computer's
 * brain (its login runners) and answers at once; the person finishes it in
 * their own browser. ADE never signs a provider in for the person.
 *
 *   start   `ade providers sign-in <provider> --remote --json`
 *   code    `ade providers sign-in-code <job> --stdin --json` (the code on the `ade` command's stdin, not its arguments)
 *   status  `ade providers sign-in-status <job> --json`
 */

const JOB_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** The command answers within ~10 s once the brain is up; a just-woken computer gets the wait `commandWith` adds. */
const SIGN_IN_EXEC_TIMEOUT_MS = 60_000;
const MAX_CODE_CHARS = 2_000;

const badRequest = (message: string) => fail("bad_request", message, 400);
const unreadable = () => fail("sign_in_unreadable", "ADE on the computer didn't answer the sign-in. Try again in a moment.", 502);

/** Single-quoted for the computer's shell; only ever used on values this file already checked. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The status a `--json` sign-in command printed, as the route's answer; 502 when it can't be read. */
function statusAnswer(stdout: string, jobId: string): Response {
  const result = readResult(stdout);
  const status = result ? statusOf(result, jobId) : null;
  return status ? json(status) : unreadable();
}

function statusOf(result: Record<string, unknown>, jobId: string): CloudRemoteSignInStatus | null {
  const state = result.state === "pending" || result.state === "done" || result.state === "failed" ? result.state as CloudRemoteSignInState : null;
  if (!state) return null;
  return {
    jobId,
    state,
    url: readString(result.url),
    userCode: readString(result.userCode),
    needsPastedCode: result.needsPastedCode === true,
    reason: readString(result.reason),
  };
}

export type SignInDeps = {
  provider: CloudProvider;
  /** Why the account's computers may not wake now (0 hours, the free plan's disk), or null. */
  wakeBlocked: () => Promise<Response | null>;
  isAwake: boolean;
  /**
   * Starts a stopped computer and records the wake. The provider's exec wakes
   * a sleeping computer by itself, but not a stopped one.
   */
  startStopped: () => Promise<void>;
  /** The computer is stopped (not asleep): exec alone wouldn't reach it. */
  isStopped: boolean;
};

/** `/cloud/instances/:id/sign-ins[/:job[/code]]`. */
export async function routeSignIns(request: Request, computer: ComputerRow, rest: string[], deps: SignInDeps): Promise<Response> {
  const exec = async (command: string): Promise<{ exitCode: number; stdout: string; stderr: string } | Response> => {
    // A command wakes a sleeping computer, under the same rules as any wake. A stopped one is started first.
    if (!deps.isAwake) {
      const blocked = await deps.wakeBlocked();
      if (blocked) return blocked;
      if (deps.isStopped) await deps.startStopped();
    }
    return await deps.provider.exec(computer.instance_id, commandWith(command), SIGN_IN_EXEC_TIMEOUT_MS);
  };

  if (rest.length === 0) {
    if (request.method !== "POST") return fail("not_found", "ADE Cloud has no such sign-in.", 404);
    const body = await readJson(request);
    if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    const row = cloudRemoteSignInOf(body.provider);
    if (!row) return badRequest("ADE doesn't know that provider.");
    // Refused before anything wakes: this one can only be signed in on a computer the person sits at.
    if (row.remoteSignIn === "none") return fail("sign_in_elsewhere", `${row.reason ?? ""} ${CLOUD_REMOTE_SIGN_IN_ELSEWHERE}`.trim(), 409);
    const ran = await exec(`ade providers sign-in ${row.provider} --remote --json`);
    if (ran instanceof Response) return ran;
    const result = readResult(ran.stdout);
    const jobId = readString(result?.jobId);
    if (!result || !jobId) {
      const reason = readString(result?.error) ?? readString(ran.stderr.split("\n").filter(Boolean).pop());
      return reason ? fail("sign_in_failed", reason.slice(0, 300), 502) : unreadable();
    }
    const started: CloudRemoteSignInStart = {
      jobId,
      url: readString(result.url),
      userCode: readString(result.userCode),
      needsPastedCode: result.needsPastedCode === true,
    };
    return json(started, 201);
  }

  const jobId = rest[0]!;
  if (!JOB_ID.test(jobId) || rest.length > 2) return fail("not_found", "ADE Cloud has no such sign-in.", 404);
  if (rest.length === 1) {
    if (request.method !== "GET") return fail("not_found", "ADE Cloud has no such sign-in.", 404);
    const ran = await exec(`ade providers sign-in-status ${shellQuote(jobId)} --json`);
    if (ran instanceof Response) return ran;
    return statusAnswer(ran.stdout, jobId);
  }
  if (rest[1] !== "code" || request.method !== "POST") return fail("not_found", "ADE Cloud has no such sign-in.", 404);
  const body = await readJson(request);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code || code.length > MAX_CODE_CHARS || /[\r\n\u0000]/.test(code)) return badRequest("That code can't be used.");
  // Base64 inside the command, so no shell quoting can break on it, and on
  // the `ade` command's stdin, so it is not in that process's arguments. It
  // is still in the short-lived shell's command line and in the exec request
  // to the provider (whose exec takes no stdin). The CLI hands it to the
  // provider's runner (`writeLoginCode`: the code, then Enter).
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(code)));
  const ran = await exec(`printf %s ${shellQuote(encoded)} | base64 -d | ade providers sign-in-code ${shellQuote(jobId)} --stdin --json`);
  if (ran instanceof Response) return ran;
  return statusAnswer(ran.stdout, jobId);
}

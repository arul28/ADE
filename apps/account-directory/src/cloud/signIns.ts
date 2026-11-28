import {
  CLOUD_SIGN_IN_CODE_REFUSED,
  CLOUD_SIGN_IN_MAX_CODES,
  CLOUD_SIGN_IN_TOO_MANY_CODES,
  cloudRemoteSignInRefusal,
  cloudRemoteSignInOf,
  cloudRemoteSignInRuns,
  type CloudServerLaunchRequest,
  type CloudRemoteSignInStart,
  type CloudRemoteSignInState,
  type CloudRemoteSignInStatus,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, badRequest, fail, json, readJson } from "./http";
import { commandWith, readResult } from "./planCleanup";
import type { CloudProvider } from "./provider";
import { captureCloudSignInStep, type CloudWaitUntil } from "./analytics";
import { signInClientOf } from "./signInWait";
import { parseJsonColumn, type CloudEnv, type ComputerRow } from "./store";

/**
 * Provider sign-ins on a cloud computer from a phone or the web (C8). The
 * server runs the computer's own command through the provider's exec, each a
 * short call: the command starts the provider's own sign-in in the computer's
 * brain (its login runners) and answers at once; the person finishes it in
 * their own browser. ADE never signs a provider in for the person.
 *
 *   start   `ade providers sign-in <provider> --remote --json`
 *   code    `ade providers sign-in-code <job> --stdin --json` (the code on the `ade` command's stdin, not its arguments);
 *           a computer's DAEX reads the job for a few seconds after it and answers the verdict
 *           (`verdict`), so a refused code says so at once
 *   status  `ade providers sign-in-status <job> --json`
 */

const JOB_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** The command answers within ~10 s once the brain is up; a just-woken computer gets the wait `commandWith` adds. */
const SIGN_IN_EXEC_TIMEOUT_MS = 60_000;
const MAX_CODE_CHARS = 2_000;
/** The window `CLOUD_SIGN_IN_MAX_CODES` counts in. */
const CODE_WINDOW_MS = 60 * 60_000;

const unreadable = () => fail("sign_in_unreadable", "DAEX on the computer didn't answer the sign-in. Try again in a moment.", 502);

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
  const verdict = result.verdict === "refused" || result.verdict === "accepted" ? result.verdict : null;
  return {
    jobId,
    state,
    url: readString(result.url),
    userCode: readString(result.userCode),
    needsPastedCode: result.needsPastedCode === true,
    // A refused code always says what to do next, whatever the provider printed.
    reason: verdict === "refused" ? CLOUD_SIGN_IN_CODE_REFUSED : readString(result.reason),
    ...(verdict ? { verdict } : {}),
  };
}

export type SignInDeps = {
  provider: CloudProvider;
  /** Why this computer may not wake now (0 hours on a size that uses them), or null. */
  wakeBlocked: () => Promise<Response | null>;
  isAwake: boolean;
  /**
   * Starts a stopped computer and records the wake. The provider's exec wakes
   * a sleeping computer by itself, but not a stopped one.
   */
  startStopped: () => Promise<void>;
  /** The computer is stopped (not asleep): exec alone wouldn't reach it. */
  isStopped: boolean;
  /** The tables (the per-job code limit) and the step's events. Left out: no limit, no events. */
  env?: CloudEnv;
  waitUntil?: CloudWaitUntil;
  now?: number;
};

/** Counts a code for this job; false once the job had `CLOUD_SIGN_IN_MAX_CODES` in its window. */
async function takeCodeSlot(env: CloudEnv, instanceId: string, jobId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(`
    insert into cloud_sign_in_codes (instance_id, job_id, count, window_start) values (?, ?, 1, ?)
    on conflict (instance_id, job_id) do update set
      count = case when cloud_sign_in_codes.window_start <= ? then 1 else cloud_sign_in_codes.count + 1 end,
      window_start = case when cloud_sign_in_codes.window_start <= ? then excluded.window_start else cloud_sign_in_codes.window_start end
    returning count
  `).bind(instanceId, jobId, now, now - CODE_WINDOW_MS, now - CODE_WINDOW_MS).first<{ count: number }>();
  return (row?.count ?? 0) <= CLOUD_SIGN_IN_MAX_CODES;
}

/** The provider of the launch waiting on this computer's sign-in, for the step's events; null when none waits. */
async function waitingLaunchOf(env: CloudEnv, computer: ComputerRow): Promise<{ launchId: string; provider: string | null } | null> {
  const row = await env.DB.prepare(`
    select launch_id, request_json from cloud_launches where instance_id = ? and user_id = ? and state = 'waiting_for_sign_in' limit 1
  `).bind(computer.instance_id, computer.user_id).first<{ launch_id: string; request_json: string | null }>();
  if (!row) return null;
  const request = parseJsonColumn<CloudServerLaunchRequest | null>(row.request_json, null, { launchId: row.launch_id, column: "request_json" });
  return { launchId: row.launch_id, provider: request?.chat?.provider ?? null };
}

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
    if (request.method !== "POST") return fail("not_found", "DAEX Cloud has no such sign-in.", 404);
    const body = await readJson(request);
    if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
    const row = cloudRemoteSignInOf(body.provider);
    if (!row) return badRequest("DAEX doesn't know that provider.");
    // Refused before anything wakes: an API key the account keeps, or a sign-in only ADE desktop runs.
    if (!cloudRemoteSignInRuns(row)) return fail("sign_in_elsewhere", cloudRemoteSignInRefusal(row), 409);
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
  if (!JOB_ID.test(jobId) || rest.length > 2) return fail("not_found", "DAEX Cloud has no such sign-in.", 404);
  if (rest.length === 1) {
    if (request.method !== "GET") return fail("not_found", "DAEX Cloud has no such sign-in.", 404);
    const ran = await exec(`ade providers sign-in-status ${shellQuote(jobId)} --json`);
    if (ran instanceof Response) return ran;
    return statusAnswer(ran.stdout, jobId);
  }
  if (rest[1] !== "code" || request.method !== "POST") return fail("not_found", "DAEX Cloud has no such sign-in.", 404);
  const body = await readJson(request);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code || code.length > MAX_CODE_CHARS || /[\r\n\u0000]/.test(code)) return badRequest("That code can't be used.");
  const now = deps.now ?? Date.now();
  if (deps.env && !(await takeCodeSlot(deps.env, computer.instance_id, jobId, now))) return fail("sign_in_too_many_codes", CLOUD_SIGN_IN_TOO_MANY_CODES, 429);
  // Base64 inside the command, so no shell quoting can break on it, and on
  // the `ade` command's stdin, so it is not in that process's arguments. It
  // is still in the short-lived shell's command line and in the exec request
  // to the provider (whose exec takes no stdin). The CLI hands it to the
  // provider's runner (`writeLoginCode`: the code, then Enter).
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(code)));
  const ran = await exec(`printf %s ${shellQuote(encoded)} | base64 -d | ade providers sign-in-code ${shellQuote(jobId)} --stdin --json`);
  if (ran instanceof Response) return ran;
  const answer = statusAnswer(ran.stdout, jobId);
  // The step's events (a cloud start's sign-in only): the code went, and the computer's verdict. Never the code.
  if (deps.env && answer.ok) {
    try {
      const launch = await waitingLaunchOf(deps.env, computer);
      if (launch) {
        const status = await answer.clone().json() as CloudRemoteSignInStatus;
        const client = signInClientOf(request);
        captureCloudSignInStep(deps.env, deps.waitUntil, computer.user_id, { step: "code_sent", provider: launch.provider, client }, launch.launchId, now);
        if (status.verdict === "refused") captureCloudSignInStep(deps.env, deps.waitUntil, computer.user_id, { step: "code_refused", provider: launch.provider, client }, launch.launchId, now);
      }
    } catch {
      // An event is never worth a failed answer.
    }
  }
  return answer;
}

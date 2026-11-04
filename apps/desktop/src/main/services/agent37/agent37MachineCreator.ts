/**
 * "New Agent37 machine": make a box from ADE's template and bring it into the
 * person's ADE account with no second sign-in.
 *
 *   1. Create the box (Agent37 answers once it is running).
 *   2. Wait for its brain, which is the box's main process.
 *   3. Start a device sign-in on the box through Agent37 exec and read its code.
 *   4. Approve that code with this computer's own account (`/device/approve`
 *      on the account directory), which answers with a one-time sign-in link.
 *   5. Open the link in a private window (hidden unless it needs a click) and
 *      wait for the sign-in to land on `/device/callback`.
 *   6. Wait for the box to finish signing in and appear in the account's
 *      machine list, and give it the name the person chose.
 *
 * Account-level by design: it acts on the Agent37 workspace and the ADE
 * account, never on a lane, chat or another machine, so it takes no pin.
 *
 * Nothing durable is planted on the box: the box receives its own session from
 * the device flow, and the account token never leaves this process.
 */

import {
  AGENT37_DEFAULT_TEMPLATE,
  agent37InstanceType,
  agent37Shape,
  isAgent37MachineKind,
  type Agent37CreateMachineArgs,
  type Agent37CreateMachineResult,
  type Agent37CreateProgress,
} from "../../../shared/agent37";
import { accountMachineConnectionState } from "../../../shared/accountDirectory";
import type { AdeAccountMachine, AdeAccountMachinesResult } from "../../../shared/types/account";
import type { Agent37Client } from "./agent37Client";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `cancelled`: ADE closed the window itself because the box signed in another way. */
export type Agent37ApprovalWindowResult = "signed_in" | "closed" | "timed_out" | "cancelled";

/**
 * `ticket`: a one-time sign-in link from `/device/approve`; nothing to type,
 * shown only if the page stops on a consent click. `browser`: the code's own
 * approval page, used when the account service can't mint a ticket; shown at
 * once, in ADE's browser session, for the person's one confirmation.
 */
export type Agent37ApprovalMode = "ticket" | "browser";

export type Agent37MachineCreatorDeps = {
  client: () => Promise<Agent37Client>;
  getAccountToken: () => Promise<string | null>;
  directoryBaseUrl: () => string | null;
  listAccountMachines: () => Promise<AdeAccountMachinesResult>;
  renameMachine: (machineKey: string, name: string) => Promise<unknown>;
  /**
   * Opens the one-time sign-in link in a private window and resolves when it
   * lands on `/device/callback`. `onNeedsPerson` fires when the page stopped
   * on something the person has to confirm and the window was shown.
   */
  approveInWindow: (args: {
    url: string;
    mode: Agent37ApprovalMode;
    title: string;
    /** Aborted when the box signed in another way: close the window. */
    signal: AbortSignal;
    onNeedsPerson: () => void;
  }) => Promise<Agent37ApprovalWindowResult>;
  templateName?: () => string;
  fetch?: FetchLike;
  logger?: {
    info?(event: string, meta?: Record<string, unknown>): void;
    warn?(event: string, meta?: Record<string, unknown>): void;
  };
  sleep?: (ms: number) => Promise<void>;
};

const BRAIN_READY_TIMEOUT_MS = 3 * 60_000;
const SIGN_IN_FINISH_TIMEOUT_MS = 90_000;
const JOIN_TIMEOUT_MS = 2 * 60_000;
const POLL_MS = 2_000;

/** `ade auth status` on the box, as JSON: whether its brain answers and is signed in. */
const AUTH_STATUS_COMMAND = "timeout 20 ade auth status --json 2>/dev/null";

/**
 * Starts `ade login --headless` on the box in the background (it keeps polling
 * for the approval after exec returns) and prints the code it shows. Reuses a
 * sign-in that is already running, so a retried exec never makes a second code.
 */
const START_SIGN_IN_COMMAND = [
  'log="$ADE_HOME/logs/agent37-sign-in.log"; pidf="$ADE_HOME/logs/agent37-sign-in.pid"',
  'mkdir -p "$ADE_HOME/logs"',
  'if ! { [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; }; then',
  '  : > "$log"',
  '  nohup setsid ade login --headless --max-wait 900 > "$log" 2>&1 < /dev/null &',
  '  echo $! > "$pidf"',
  "fi",
  "i=0",
  "while [ $i -lt 90 ]; do",
  '  code=$(sed -n "s/.*enter code: *\\([A-Za-z0-9-]*\\).*/\\1/p" "$log" | head -n 1)',
  '  if [ -n "$code" ]; then echo "ADE_USER_CODE=$code"; exit 0; fi',
  '  if ! kill -0 "$(cat "$pidf")" 2>/dev/null; then break; fi',
  "  sleep 1; i=$((i+1))",
  "done",
  'tail -n 5 "$log" >&2',
  "exit 3",
].join("\n");

/** The box's own machine key: the row it publishes to the account directory. */
const MACHINE_KEY_COMMAND = [
  'node -e \'const fs=require("fs"),p=require("path");',
  'const f=p.join(process.env.ADE_HOME||p.join(require("os").homedir(),".ade"),"secrets","sync-cloud-relay.json");',
  'try{const j=JSON.parse(fs.readFileSync(f,"utf8"));const c=j.config||j;process.stdout.write(String(c.machineKey||""))}catch{}\'',
].join("");

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** `/device/approve`'s refusals, in words. */
function approvalErrorMessage(status: number, code: string | null): string {
  if (status === 401) return "Your ADE sign-in on this computer has expired. Sign in again, then make the machine.";
  if (code === "expired") return "The new machine's sign-in code expired before ADE could approve it. Try again.";
  if (code === "already_used") return "The new machine's sign-in code was already used. Try again.";
  if (code === "rate_limited") return "Too many sign-in approvals in a row. Wait a minute and try again.";
  if (status === 503 || code === "unavailable") return "ADE's account service can't approve sign-ins right now. Try again in a moment.";
  return `ADE's account service refused the sign-in (${status}).`;
}

export function normalizeAgent37MachineName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned || "Agent37 box";
}

export async function createAgent37Machine(
  deps: Agent37MachineCreatorDeps,
  requestId: string,
  rawArgs: Agent37CreateMachineArgs,
  onProgress: (progress: Agent37CreateProgress) => void,
): Promise<Agent37CreateMachineResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetcher: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  if (!isAgent37MachineKind(rawArgs?.kind)) throw new Error("Pick a box or a VM.");
  const shape = agent37Shape(rawArgs?.shape);
  if (!shape) throw new Error("Pick a size.");
  const name = normalizeAgent37MachineName(rawArgs?.name ?? "");
  const template = deps.templateName?.() || AGENT37_DEFAULT_TEMPLATE;
  const progress = (stage: Agent37CreateProgress["stage"], message: string, instanceId?: string) =>
    onProgress({ requestId, stage, message, ...(instanceId ? { instanceId } : {}) });

  // Everything that can fail before money is spent is checked first.
  const client = await deps.client();
  const directory = deps.directoryBaseUrl();
  if (!directory) throw new Error("ADE's account service isn't configured on this computer, so it can't sign the new machine in.");
  if (!(await deps.getAccountToken())) throw new Error("Sign in to ADE on this computer first. The new machine joins your account.");
  if (!(await client.hasTemplate(template))) {
    throw new Error(`ADE's machine template ("${template}") isn't in your Agent37 workspace yet, so ADE can't make a machine from it.`);
  }

  progress("creating", `Making ${name} on Agent37…`);
  const instance = await client.createInstance({
    template,
    name,
    type: agent37InstanceType(rawArgs.kind),
    resources: { cpu: shape.cpu, memory: shape.memoryGb, disk: shape.diskGb },
    metadata: { created_by: "ade" },
  });
  deps.logger?.info?.("agent37.machine_created", { instanceId: instance.id, kind: rawArgs.kind, shape: shape.id });

  let signedIn = false;
  try {
    progress("waiting_for_brain", "Starting ADE on the new machine…", instance.id);
    const readAuth = async (): Promise<Record<string, unknown> | null> => {
      const result = await client.exec(instance.id, AUTH_STATUS_COMMAND, { timeoutMs: 40_000 }).catch(() => null);
      return result && result.exitCode === 0 ? parseJsonObject(result.stdout) : null;
    };
    const brainDeadline = Date.now() + BRAIN_READY_TIMEOUT_MS;
    let auth = await readAuth();
    while (!auth) {
      if (Date.now() > brainDeadline) throw new Error("ADE did not start on the new machine in time.");
      await sleep(POLL_MS);
      auth = await readAuth();
    }

    if (auth.signedIn !== true) {
      progress("signing_in", "Signing the new machine in to your account…", instance.id);
      const started = await client.exec(instance.id, START_SIGN_IN_COMMAND, { timeoutMs: 120_000 });
      const userCode = /ADE_USER_CODE=([A-Za-z0-9-]+)/.exec(started.stdout)?.[1] ?? null;
      if (!userCode) {
        deps.logger?.warn?.("agent37.sign_in_no_code", { instanceId: instance.id, exitCode: started.exitCode });
        throw new Error("The new machine didn't start its sign-in.");
      }

      const approve = async (token: string) => await fetcher(`${directory.replace(/\/+$/, "")}/device/approve`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_code: userCode }),
        redirect: "error",
      });
      const token = await deps.getAccountToken();
      if (!token) throw new Error("Sign in to ADE on this computer first. The new machine joins your account.");
      const response = await approve(token);
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const ticketUrl = typeof body?.url === "string" && /^https:\/\//.test(body.url) ? body.url : null;
      const refusal = typeof body?.error === "string" ? body.error : null;
      let window: { url: string; mode: Agent37ApprovalMode };
      if (response.ok && ticketUrl) {
        window = { url: ticketUrl, mode: "ticket" };
      } else if (response.status === 503 && refusal === "unavailable") {
        // The account service can't mint a one-time ticket (no Clerk backend
        // key). The code is still pending, so its own approval page works:
        // the person confirms once, in ADE's browser session.
        deps.logger?.warn?.("agent37.approve_ticket_unavailable", { instanceId: instance.id });
        window = { url: `${directory.replace(/\/+$/, "")}/device?user_code=${encodeURIComponent(userCode)}`, mode: "browser" };
      } else {
        throw new Error(approvalErrorMessage(response.status, refusal));
      }

      // The box itself is the authority: an approval from anywhere (this
      // window, a phone, another browser) ends the wait, and closes the window.
      const stopWatching = new AbortController();
      const boxSignedIn = (async () => {
        while (!stopWatching.signal.aborted) {
          if ((await readAuth())?.signedIn === true) return true;
          await sleep(POLL_MS);
        }
        return false;
      })();
      const windowOutcome = deps.approveInWindow({
        ...window,
        title: `Sign in ${name}`,
        signal: stopWatching.signal,
        onNeedsPerson: () => progress("confirm_in_window", `Confirm in the window that opened to let ${name} use your account.`, instance.id),
      });
      const first = await Promise.race([
        boxSignedIn.then((ok) => ({ kind: "box" as const, ok })),
        windowOutcome.then((outcome) => ({ kind: "window" as const, outcome })),
      ]);
      stopWatching.abort();

      if (first.kind === "window" && first.outcome !== "cancelled") {
        if (first.outcome === "signed_in") {
          // The approval landed; give the box a moment to collect its session.
          const finishDeadline = Date.now() + SIGN_IN_FINISH_TIMEOUT_MS;
          for (;;) {
            if ((await readAuth())?.signedIn === true) break;
            if (Date.now() > finishDeadline) throw new Error("The new machine was approved but didn't finish signing in.");
            await sleep(POLL_MS);
          }
        } else if ((await readAuth())?.signedIn !== true) {
          throw new Error(first.outcome === "closed"
            ? "The sign-in window was closed before the new machine was approved."
            : "The new machine's sign-in didn't finish in time.");
        }
      }
    }
    signedIn = true;
  } catch (error) {
    // A box that never joined is only a bill: take it back off Agent37.
    deps.logger?.warn?.("agent37.machine_setup_failed", {
      instanceId: instance.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await client.deleteInstance(instance.id).catch((deleteError: unknown) => {
      deps.logger?.warn?.("agent37.machine_cleanup_failed", {
        instanceId: instance.id,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason} ADE deleted the box it made, so it isn't billing.`);
  }

  progress("joining", `${name} is signed in. Adding it to your computers…`, instance.id);
  const machineKey = signedIn
    ? (await client.exec(instance.id, MACHINE_KEY_COMMAND).catch(() => null))?.stdout.trim() || null
    : null;
  let joined: AdeAccountMachine | null = null;
  if (machineKey) {
    // The row appears with the box's first publish, a moment before its relay
    // route does; connecting in that moment fails, so wait for a route.
    const joinDeadline = Date.now() + JOIN_TIMEOUT_MS;
    let renamed = false;
    while (!joined && Date.now() < joinDeadline) {
      const listed = await deps.listAccountMachines().catch(() => null);
      const row = listed?.machines.find((machine) => machine.machineKey === machineKey) ?? null;
      if (row && !renamed) {
        renamed = true;
        await deps.renameMachine(machineKey, name).catch(() => undefined);
      }
      if (row && accountMachineConnectionState(row) === "available") joined = row;
      else await sleep(POLL_MS);
    }
  }
  return { instanceId: instance.id, machineKey: joined ? machineKey : null, name };
}

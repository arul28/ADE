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
import type { Agent37Client, Agent37Instance } from "./agent37Client";
import { recordAgent37MachineKey } from "./agent37Machines";
import {
  deleteAgent37InstanceConfirmed,
  readAgent37BoxSignedIn,
  reconcileAgent37PendingCreate,
  type Agent37PendingCreateStore,
  type Agent37ReconcileResult,
} from "./agent37PendingCreates";

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
  /**
   * Why the template can't be used yet (ADE is still building it), or null.
   * Asked before anything is made, so a create never waits on a build.
   */
  templateNotReady?: () => string | null;
  /** The workspace has no template: start building it. */
  onTemplateMissing?: () => void;
  /**
   * Creates not yet resolved, kept on disk from before the create request goes
   * out, so a box whose create was cut short (a lost answer, an app quit) is
   * found by its request id and deleted at the next start.
   */
  pendingCreates?: Agent37PendingCreateStore;
};

/** The person cancelled (closed the dialog or pressed Cancel). */
export class Agent37CreateCancelled extends Error {
  constructor(message = "You cancelled making the machine.") {
    super(message);
    this.name = "Agent37CreateCancelled";
  }
}

const BRAIN_READY_TIMEOUT_MS = 3 * 60_000;
const SIGN_IN_FINISH_TIMEOUT_MS = 90_000;
const JOIN_TIMEOUT_MS = 2 * 60_000;
const POLL_MS = 2_000;
/** `/device/approve` answers in a second; this bounds a stalled account service. */
const APPROVE_TIMEOUT_MS = 20_000;
/** How long a cancelled create keeps looking for a box Agent 37 still made. */
const CANCELLED_CREATE_LOOK_MS = 90_000;
/**
 * After that, in the background: longer than Agent 37 holds a create request
 * (CREATE_TIMEOUT_MS in the client, five minutes), with room for its answer.
 */
const CANCELLED_CREATE_FOLLOW_MS = 10 * 60_000;
const CANCELLED_CREATE_FOLLOW_POLL_MS = 15_000;
/** Rename tries once the row is ready to connect, before ADE stops waiting on it. */
const RENAME_ATTEMPTS_AFTER_JOIN = 3;

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
  return cleaned || "Agent 37 box";
}

export async function createAgent37Machine(
  deps: Agent37MachineCreatorDeps,
  requestId: string,
  rawArgs: Agent37CreateMachineArgs,
  onProgress: (progress: Agent37CreateProgress) => void,
  signal?: AbortSignal,
  /** More tags for the box (a ready machine's project and state); ADE's own tags win. */
  extraMetadata?: Record<string, string>,
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
  const checkCancelled = () => {
    if (signal?.aborted) throw new Agent37CreateCancelled();
  };

  // Everything that can fail before money is spent is checked first.
  const notReady = deps.templateNotReady?.() ?? null;
  if (notReady) throw new Error(notReady);
  const client = await deps.client();
  const directory = deps.directoryBaseUrl();
  if (!directory) throw new Error("ADE's account service isn't configured on this computer, so it can't sign the new machine in.");
  if (!(await deps.getAccountToken())) throw new Error("Sign in to ADE on this computer first. The new machine joins your account.");
  if (!(await client.hasTemplate(template))) {
    deps.onTemplateMissing?.();
    throw new Error(`ADE's machine template ("${template}") isn't in your Agent 37 workspace yet. ADE is setting it up now (about five minutes); try again then.`);
  }
  checkCancelled();
  const logger = deps.logger ?? {};
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // On disk before the request goes out: whatever happens to the answer, the
  // box carries this request id and the next start can find it.
  // If ADE cannot write down that it is making a box, it does not make one:
  // a quit before the answer would leave a box nothing can find.
  try {
    deps.pendingCreates?.begin(requestId, Date.now());
  } catch (error) {
    logger.warn?.("agent37.machine_create_not_recorded", { error: errorText(error) });
    throw new Error("ADE couldn't save a note of the machine it's about to make, so it didn't make one. Check that ADE can write to its folder, then try again.");
  }
  progress("creating", `Making ${name} on Agent 37…`);
  let instance: Agent37Instance;
  try {
    instance = await client.createInstance({
      template,
      name,
      type: agent37InstanceType(rawArgs.kind),
      resources: { cpu: shape.cpu, memory: shape.memoryGb, disk: shape.diskGb },
      metadata: { ...extraMetadata, created_by: "ade", ade_request_id: requestId },
    }, signal);
  } catch (error) {
    // A create that timed out or broke mid-way may still have made a box.
    // Find it by the tag ADE put on it and take it back off Agent 37; what
    // can't be confirmed stays recorded for the next start.
    const reconcileOnce = () => deps.pendingCreates
      ? reconcileAgent37PendingCreate(
        client,
        deps.pendingCreates.list().find((record) => record.requestId === requestId)
          ?? { requestId, startedAt: Date.now(), instanceIds: [] },
        { store: deps.pendingCreates, logger, sleep },
      ).catch((reconcileError: unknown) => {
        logger.warn?.("agent37.machine_create_reconcile_failed", { requestId, error: errorText(reconcileError) });
        return null;
      })
      : Promise.resolve(null);
    let cleanup = await reconcileOnce();
    // A cancel stops ADE waiting, not Agent 37 making the box: it can still
    // appear a few seconds later. Look for it for a while so a cancelled box
    // doesn't bill until the next app start (which would still catch it).
    if (signal?.aborted) {
      const lookUntil = Date.now() + CANCELLED_CREATE_LOOK_MS;
      while (cleanup && !cleanup.resolved && Date.now() < lookUntil) {
        await sleep(POLL_MS);
        cleanup = await reconcileOnce();
      }
    }
    if (signal?.aborted) {
      if (cleanup && !cleanup.resolved) {
        // Agent 37 can still be making the box for as long as its create
        // request runs. Keep looking in the background, past this answer,
        // until the request resolves; the next app start covers a quit.
        void (async () => {
          const followUntil = Date.now() + CANCELLED_CREATE_FOLLOW_MS;
          let followed: Agent37ReconcileResult | null = cleanup;
          while (followed && !followed.resolved && Date.now() < followUntil) {
            await sleep(CANCELLED_CREATE_FOLLOW_POLL_MS);
            followed = await reconcileOnce();
          }
          logger.info?.("agent37.cancelled_create_followed", { requestId, resolved: followed?.resolved ?? false });
        })().catch((followError: unknown) => {
          logger.warn?.("agent37.cancelled_create_follow_failed", { requestId, error: errorText(followError) });
        });
      }
      throw new Agent37CreateCancelled(cleanup?.resolved
        ? undefined
        : "ADE stopped making the machine. If Agent 37 still makes it, ADE deletes it as soon as it appears.");
    }
    if (cleanup && cleanup.unresolved.length) {
      throw new Error(`${errorText(error).replace(/\.$/, "")}. Agent 37 may have made the box anyway and ADE couldn't delete it yet; it tries again when ADE next starts.`);
    }
    throw error;
  }
  deps.pendingCreates?.attach(requestId, instance.id);
  logger.info?.("agent37.machine_created", { instanceId: instance.id, kind: rawArgs.kind, shape: shape.id });

  // Set once ADE asks the account to approve the box's sign-in. Before that the
  // box cannot be signed in to this account, so a failure may delete it
  // outright; after it, only the box's own answer decides.
  let approvalSent = false;
  try {
    checkCancelled();
    progress("waiting_for_brain", "Starting ADE on the new machine…", instance.id);
    const readAuth = async (): Promise<Record<string, unknown> | null> => {
      const result = await client.exec(instance.id, AUTH_STATUS_COMMAND, { timeoutMs: 40_000, signal }).catch(() => null);
      return result && result.exitCode === 0 ? parseJsonObject(result.stdout) : null;
    };
    const brainDeadline = Date.now() + BRAIN_READY_TIMEOUT_MS;
    let auth = await readAuth();
    while (!auth) {
      checkCancelled();
      if (Date.now() > brainDeadline) throw new Error("ADE did not start on the new machine in time.");
      // A box that Agent 37 itself gave up on will never answer.
      const state = (await client.getInstance(instance.id).catch(() => null))?.status ?? null;
      if (state === "failed" || state === "deleted") {
        throw new Error(state === "failed" ? "Agent 37 couldn't start the new machine." : "The new machine was deleted on Agent 37.");
      }
      await sleep(POLL_MS);
      auth = await readAuth();
    }
    checkCancelled();

    if (auth.signedIn !== true) {
      progress("signing_in", "Signing the new machine in to your account…", instance.id);
      const started = await client.exec(instance.id, START_SIGN_IN_COMMAND, { timeoutMs: 120_000, signal });
      checkCancelled();
      const userCode = /ADE_USER_CODE=([A-Za-z0-9-]+)/.exec(started.stdout)?.[1] ?? null;
      if (!userCode) {
        logger.warn?.("agent37.sign_in_no_code", { instanceId: instance.id, exitCode: started.exitCode });
        throw new Error("The new machine didn't start its sign-in.");
      }

      const token = await deps.getAccountToken();
      if (!token) throw new Error("Sign in to ADE on this computer first. The new machine joins your account.");
      // Bounded, and cancelled with the create: a stalled account service must
      // not hold a cancel (and the box's deletion) for as long as it likes.
      const approveController = new AbortController();
      const approveTimer = setTimeout(() => approveController.abort(), APPROVE_TIMEOUT_MS);
      const onCancelApprove = () => approveController.abort();
      if (signal?.aborted) approveController.abort();
      else signal?.addEventListener("abort", onCancelApprove, { once: true });
      let response: Response;
      let body: Record<string, unknown> | null;
      try {
        approvalSent = true;
        response = await fetcher(`${directory.replace(/\/+$/, "")}/device/approve`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ user_code: userCode }),
          redirect: "error",
          signal: approveController.signal,
        });
        body = await response.json().catch(() => {
          if (approveController.signal.aborted) throw new Error("aborted");
          return null;
        }) as Record<string, unknown> | null;
      } catch (approveError) {
        checkCancelled();
        if (approveController.signal.aborted) throw new Error("ADE's account service didn't answer in time to approve the new machine's sign-in. Try again.");
        throw new Error(`ADE couldn't reach its account service to approve the new machine's sign-in: ${errorText(approveError)}`);
      } finally {
        clearTimeout(approveTimer);
        signal?.removeEventListener("abort", onCancelApprove);
      }
      checkCancelled();
      const ticketUrl = typeof body?.url === "string" && /^https:\/\//.test(body.url) ? body.url : null;
      const refusal = typeof body?.error === "string" ? body.error : null;
      let window: { url: string; mode: Agent37ApprovalMode };
      if (response.ok && ticketUrl) {
        window = { url: ticketUrl, mode: "ticket" };
      } else if (response.status === 503 && refusal === "unavailable") {
        // The account service can't mint a one-time ticket (no Clerk backend
        // key). The code is still pending, so its own approval page works:
        // the person confirms once, in ADE's browser session.
        logger.warn?.("agent37.approve_ticket_unavailable", { instanceId: instance.id });
        window = { url: `${directory.replace(/\/+$/, "")}/device?user_code=${encodeURIComponent(userCode)}`, mode: "browser" };
      } else {
        throw new Error(approvalErrorMessage(response.status, refusal));
      }

      // The box itself is the authority: an approval from anywhere (this
      // window, a phone, another browser) ends the wait, and closes the window.
      const stopWatching = new AbortController();
      // Cancelling the create closes the window too, including a cancel that
      // came before this point.
      const onCancelWatch = () => stopWatching.abort();
      signal?.addEventListener("abort", onCancelWatch, { once: true });
      if (signal?.aborted) stopWatching.abort();
      try {
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
        checkCancelled();

        if (first.kind === "window" && first.outcome !== "cancelled") {
          if (first.outcome === "signed_in") {
            // The approval landed; give the box a moment to collect its session.
            const finishDeadline = Date.now() + SIGN_IN_FINISH_TIMEOUT_MS;
            for (;;) {
              checkCancelled();
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
      } finally {
        stopWatching.abort();
        signal?.removeEventListener("abort", onCancelWatch);
      }
    }
    // Signed in: a real machine, kept from here on.
    deps.pendingCreates?.finish(requestId);
  } catch (error) {
    logger.warn?.("agent37.machine_setup_failed", { instanceId: instance.id, error: errorText(error) });
    const reasonFor = () => (signal?.aborted ? new Agent37CreateCancelled().message : errorText(error));
    // A cancel or failure after approval may come after the box signed in: then
    // it is a real machine on the account, not a bill, and is kept. Asked
    // without the create's signal, which a cancel has already aborted.
    if (approvalSent) {
      const signedIn = await readAgent37BoxSignedIn(client, instance.id, logger);
      if (signedIn === true) {
        deps.pendingCreates?.finish(requestId);
        logger.info?.("agent37.machine_kept_signed_in", { instanceId: instance.id, requestId });
        throw new Error(`${reasonFor()} "${name}" had already signed in, so ADE kept it: it's under Your computers. Delete it from its row if you don't want it.`);
      }
      if (signedIn === "unknown") {
        // Left on the pending list: the next start asks the box again and
        // deletes it only on a clear "signed out".
        throw new Error(`${reasonFor()} ADE couldn't tell whether "${name}" (${instance.id}) finished signing in, so it didn't delete it. If it isn't under Your computers, delete it in your Agent 37 dashboard; ADE also checks again when it next starts.`);
      }
    }
    // A box that never signed in is only a bill: take it back off Agent 37.
    const deleted = await deleteAgent37InstanceConfirmed(client, instance.id, { logger, sleep });
    // Kept on the pending list until Agent 37 confirms: the next app start tries again.
    if (deleted) {
      logger.warn?.("agent37.half_made_box_deleted", { instanceId: instance.id, requestId });
      deps.pendingCreates?.finish(requestId);
    }
    // A request the cancel cut short reads as the cancel, not as its own error.
    const reason = reasonFor();
    throw new Error(deleted
      ? `${reason} ADE deleted the box it made, so it isn't billing.`
      : `${reason} ADE couldn't confirm it deleted the box it made ("${name}", ${instance.id}). Delete it in your Agent 37 dashboard so it stops billing; ADE also tries again when it next starts.`);
  }

  progress("joining", `${name} is signed in. Adding it to your computers…`, instance.id);
  // The row appears with the box's first publish, a moment before its relay
  // route does; connecting in that moment fails, so wait for a route. A box
  // that isn't ready by the deadline is still a signed-in machine: the caller
  // keeps watching the account list for it.
  const joinDeadline = Date.now() + JOIN_TIMEOUT_MS;
  let machineKey: string | null = null;
  let joined = false;
  let renamed = false;
  let renameAttemptsAfterJoin = 0;
  const warnedOnce = new Set<string>();
  const warnOnce = (event: string, meta: Record<string, unknown>) => {
    if (warnedOnce.has(event)) return;
    warnedOnce.add(event);
    logger.warn?.(event, meta);
  };
  while (Date.now() < joinDeadline) {
    // Signed in already, so a cancel here keeps the box (it is a real machine)
    // and only stops the wait; it is not reported as a finished create.
    if (signal?.aborted) {
      logger.info?.("agent37.machine_join_cancelled", { instanceId: instance.id, requestId });
      throw new Agent37CreateCancelled(`You stopped waiting. "${name}" had already signed in, so ADE kept it: it appears under Your computers when it's ready.`);
    }
    if (!machineKey) {
      const read = await client.exec(instance.id, MACHINE_KEY_COMMAND).catch((error: unknown) => {
        warnOnce("agent37.machine_key_read_failed", { instanceId: instance.id, error: errorText(error) });
        return null;
      });
      machineKey = read?.stdout.trim() || null;
      // On the box itself, so every computer on the account can tell which
      // row is this box, whatever it is named later.
      if (machineKey) await recordAgent37MachineKey(client, instance.id, machineKey, logger);
    }
    if (machineKey) {
      const listed = await deps.listAccountMachines().catch((error: unknown) => {
        warnOnce("agent37.account_machines_read_failed", { instanceId: instance.id, error: errorText(error) });
        return null;
      });
      const row = listed?.machines.find((machine) => machine.machineKey === machineKey) ?? null;
      if (row && !renamed) {
        try {
          await deps.renameMachine(machineKey, name);
          renamed = true;
        } catch (error) {
          logger.warn?.("agent37.machine_rename_failed", { instanceId: instance.id, error: errorText(error) });
        }
      }
      if (row && accountMachineConnectionState(row) === "available") joined = true;
      if (joined) {
        if (renamed || renameAttemptsAfterJoin >= RENAME_ATTEMPTS_AFTER_JOIN) break;
        renameAttemptsAfterJoin += 1;
      }
    }
    await sleep(POLL_MS);
  }
  if (!renamed) logger.warn?.("agent37.machine_rename_gave_up", { instanceId: instance.id, joined, hasMachineKey: machineKey != null });
  if (!joined) logger.warn?.("agent37.machine_join_pending", { instanceId: instance.id, hasMachineKey: machineKey != null });
  return { instanceId: instance.id, machineKey, name, joined, renamed };
}

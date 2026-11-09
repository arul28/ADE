/**
 * "New cloud machine": make a box from ADE's template and bring it into the
 * person's ADE account with no second sign-in.
 *
 *   1. Create the box (the provider answers once it is running).
 *   2. Wait for its brain, which is the box's main process.
 *   3. Start a device sign-in on the box through the provider exec and read its code.
 *   4. Approve that code with this computer's own account (`/device/approve`
 *      on the account directory), which answers with a one-time sign-in link.
 *   5. Open the link in a private window (hidden unless it needs a click) and
 *      wait for the sign-in to land on `/device/callback`.
 *   6. Wait for the box to finish signing in and appear in the account's
 *      machine list, and give it the name the person chose.
 *
 * Account-level by design: it acts on the account's cloud machines and the ADE
 * account, never on a lane, chat or another machine, so it takes no pin.
 *
 * Nothing durable is planted on the box: the box receives its own session from
 * the device flow, and the account token never leaves this process.
 */

import {
  CLOUD_WAKE_PORT,
  CLOUD_WAKE_PORT_LABEL,
  cloudInstanceType,
  cloudShape,
  isCloudMachineKind,
  type CloudCreateMachineArgs,
  type CloudCreateMachineResult,
  type CloudCreateProgress,
} from "../../../shared/adeCloud";
import { accountMachineConnectionState } from "../../../shared/accountDirectory";
import type { AdeAccountMachinesResult } from "../../../shared/types/account";
import type { CloudProvider, CloudInstance } from "./cloudProvider";
import { recordCloudMachineKey } from "./cloudMachines";
import { enableCloudSleep } from "./cloudSleep";
import {
  deleteCloudInstanceConfirmed,
  readCloudBoxSignedIn,
  reconcileCloudPendingCreate,
  type CloudPendingCreateStore,
  type CloudReconcileResult,
} from "./cloudPendingCreates";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `cancelled`: ADE closed the window itself because the box signed in another way. */
export type CloudApprovalWindowResult = "signed_in" | "closed" | "timed_out" | "cancelled";

/**
 * `ticket`: a one-time sign-in link from `/device/approve`; nothing to type,
 * shown only if the page stops on a consent click. `browser`: the code's own
 * approval page, used when the account service can't mint a ticket; shown at
 * once, in ADE's browser session, for the person's one confirmation.
 */
export type CloudApprovalMode = "ticket" | "browser";

export type CloudMachineCreatorDeps = {
  client: () => Promise<CloudProvider>;
  getAccountToken: () => Promise<string | null>;
  directoryBaseUrl: () => string | null;
  listAccountMachines: () => Promise<AdeAccountMachinesResult>;
  renameMachine: (machineKey: string, name: string) => Promise<unknown>;
  /**
   * Opens the one-time sign-in link in a private window and resolves when it
   * lands on `/device/callback`. `onNeedsPerson` fires when the page stopped
   * on something the person has to confirm and the window was shown.
   */
  approveInWindow?: (args: {
    url: string;
    mode: CloudApprovalMode;
    title: string;
    /** Aborted when the box signed in another way: close the window. */
    signal: AbortSignal;
    onNeedsPerson: () => void;
  }) => Promise<CloudApprovalWindowResult>;
  /**
   * With no window to open (a brain on its own): the sign-in link for the
   * person to approve wherever they are signed in to ADE (the phone opens it
   * natively, any browser works). Used only when `approveInWindow` is unset.
   */
  handOffApproval?: (args: { url: string; userCode: string; name: string }) => void;
  /**
   * A brain with no window: the one-time link opened in a headless Chromium
   * on this machine (cloudHeadlessApproval.ts). Used only when the sign-in
   * passes `selfApproval`; anything short of signed in falls back to
   * `handOffApproval` with a fresh code.
   */
  approveHeadless?: (args: { url: string; signal: AbortSignal }) => Promise<CloudApprovalWindowResult>;
  /**
   * Whether this brain may approve the new machine itself: a machine it made
   * for this request, once, soon after the create, within the hours and the
   * agent limits. Logged by the brain each time it answers yes.
   */
  selfApproval?: (args: { instanceId: string; requestId: string }) => Promise<boolean>;
  /**
   * Env the new machine starts with: the person's provider sign-ins, so they
   * work from the first chat (cloudSignInStore.ts). the provider
   * keeps it with the machine and gives it back on every boot.
   */
  machineEnv?: () => Promise<Record<string, string>>;
  /**
   * The ADE release this computer runs, or null for a build that is not a
   * published release. The machine installs it on boot when its template is
   * older (`ADE_MIN_VERSION` in infra/ade-cloud/template/ade-entrypoint.sh), so a
   * machine made while the template is still being rebuilt for this release
   * joins on it anyway.
   */
  minAdeVersion?: () => string | null;
  fetch?: FetchLike;
  logger?: {
    info?(event: string, meta?: Record<string, unknown>): void;
    warn?(event: string, meta?: Record<string, unknown>): void;
  };
  sleep?: (ms: number) => Promise<void>;
  /**
   * Creates not yet resolved, kept on disk from before the create request goes
   * out, so a box whose create was cut short (a lost answer, an app quit) is
   * found by its request id and deleted at the next start.
   */
  pendingCreates?: CloudPendingCreateStore;
  /** Minutes of nothing running before a new box sleeps (the provider's idle timer). */
  sleepAfterMinutes?: () => number | null;
};

/** The person cancelled (closed the dialog or pressed Cancel). */
export class CloudCreateCancelled extends Error {
  constructor(message = "You cancelled making the machine.") {
    super(message);
    this.name = "CloudCreateCancelled";
  }
}

const CLOUD_CANT_MAKE_COMPUTER_MESSAGE = "ADE Cloud can't make a computer right now. Try again soon.";

const BRAIN_READY_TIMEOUT_MS = 3 * 60_000;
const SIGN_IN_FINISH_TIMEOUT_MS = 90_000;
const JOIN_TIMEOUT_MS = 2 * 60_000;
const POLL_MS = 2_000;
/** `/device/approve` answers in a second; this bounds a stalled account service. */
const APPROVE_TIMEOUT_MS = 20_000;
/** As long as the account keeps a sign-in code (DEVICE_CODE_TTL_SECONDS). */
const APPROVE_ELSEWHERE_TIMEOUT_MS = 10 * 60_000;
/** How long a cancelled create keeps looking for a box the provider still made. */
const CANCELLED_CREATE_LOOK_MS = 90_000;
/**
 * After that, in the background: longer than the provider holds a create request
 * (CREATE_TIMEOUT_MS in the client, five minutes), with room for its answer.
 */
const CANCELLED_CREATE_FOLLOW_MS = 10 * 60_000;
const CANCELLED_CREATE_FOLLOW_POLL_MS = 15_000;
/** Rename tries once the row is ready to connect, before ADE stops waiting on it. */
const RENAME_ATTEMPTS_AFTER_JOIN = 3;

/** `ade auth status` on the box, as JSON: whether its brain answers and is signed in. */
const AUTH_STATUS_COMMAND = "timeout 20 ade auth status --json 2>/dev/null";

/**
 * Starts a device sign-in on the box in the background (it keeps polling for
 * the approval after exec returns) and prints the code it shows: `ade login
 * --headless` for a new machine, `ade machines reconnect` for one removed from
 * the account. Reuses a sign-in that is already running, so a retried exec
 * never makes a second code.
 */
function startSignInCommand(kind: "login" | "reconnect", fresh = false): string {
  const command = kind === "login" ? "ade login --headless --max-wait 900" : "ade machines reconnect";
  const files = `$ADE_HOME/logs/cloud-${kind === "login" ? "sign-in" : "reconnect"}`;
  return [
    `log="${files}.log"; pidf="${files}.pid"`,
    'mkdir -p "$ADE_HOME/logs"',
    // A fresh code: the running sign-in's code was already used.
    ...(fresh ? [`if [ -f "$pidf" ] && grep -q ${kind} "/proc/$(cat "$pidf")/cmdline" 2>/dev/null; then kill "$(cat "$pidf")" 2>/dev/null; sleep 1; fi`] : []),
    // A pid only counts while it is still that command: a copied disk (a fork)
    // carries its source's pid file, and the number can belong to anything here.
    `if ! { [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && grep -q ${kind} "/proc/$(cat "$pidf")/cmdline" 2>/dev/null; }; then`,
    '  : > "$log"',
    `  nohup setsid ${command} > "$log" 2>&1 < /dev/null &`,
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
}

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

/** The box's `ade auth status`, or null while its brain doesn't answer. */
export async function readCloudBoxAuth(client: CloudProvider, instanceId: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const result = await client.exec(instanceId, AUTH_STATUS_COMMAND, { timeoutMs: 40_000, signal }).catch(() => null);
  return result && result.exitCode === 0 ? parseJsonObject(result.stdout) : null;
}

/**
 * The box's `ade auth status` once its brain answers, which takes a moment
 * after a start or a wake. Throws past the deadline, or when the provider itself
 * gave up on the box (it will never answer).
 */
export async function waitForCloudBoxAuth(
  client: CloudProvider,
  instanceId: string,
  options: { signal?: AbortSignal; sleep: (ms: number) => Promise<void>; machine: string },
): Promise<Record<string, unknown>> {
  const { signal, machine } = options;
  const deadline = Date.now() + BRAIN_READY_TIMEOUT_MS;
  let auth = await readCloudBoxAuth(client, instanceId, signal);
  while (!auth) {
    if (signal?.aborted) throw new CloudCreateCancelled();
    if (Date.now() > deadline) throw new Error(`ADE did not start on ${machine} in time.`);
    const state = (await client.getInstance(instanceId).catch(() => null))?.status ?? null;
    if (state === "failed" || state === "deleted") {
      throw new Error(state === "failed" ? `ADE Cloud couldn't start ${machine}.` : `ADE Cloud deleted ${machine}.`);
    }
    await options.sleep(POLL_MS);
    auth = await readCloudBoxAuth(client, instanceId, signal);
  }
  return auth;
}

/** Starts a device sign-in on the box (see `startSignInCommand`) and returns its code, or null when none showed. */
export async function startCloudBoxSignIn(
  client: CloudProvider,
  instanceId: string,
  kind: "login" | "reconnect",
  signal?: AbortSignal,
  options: { fresh?: boolean } = {},
): Promise<{ userCode: string | null; exitCode: number }> {
  const started = await client.exec(instanceId, startSignInCommand(kind, options.fresh === true), { timeoutMs: 120_000, signal });
  return { userCode: /ADE_USER_CODE=([A-Za-z0-9-]+)/.exec(started.stdout)?.[1] ?? null, exitCode: started.exitCode };
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

export function normalizeCloudMachineName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned || "ADE Cloud box";
}

/** A published release a machine can install (`ade brain update --version`), or null. */
function cloudMinAdeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/, "") ?? "";
  // 0.0.0 is an unstamped development build; alpha builds are not published.
  if (trimmed === "0.0.0" || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

export async function createCloudMachine(
  deps: CloudMachineCreatorDeps,
  requestId: string,
  rawArgs: CloudCreateMachineArgs,
  onProgress: (progress: CloudCreateProgress) => void,
  options: {
    /** Cancels the create (the dialog closed); a box that never signed in is deleted. */
    signal?: AbortSignal;
    /** More tags for the box (a ready machine's project and state); ADE's own tags win. */
    metadata?: Record<string, string>;
  } = {},
): Promise<CloudCreateMachineResult> {
  const { signal } = options;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!isCloudMachineKind(rawArgs?.kind)) throw new Error("Pick a box or a VM.");
  const shape = cloudShape(rawArgs?.shape);
  if (!shape) throw new Error("Pick a size.");
  const name = normalizeCloudMachineName(rawArgs?.name ?? "");
  const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) =>
    onProgress({ requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  const checkCancelled = () => {
    if (signal?.aborted) throw new CloudCreateCancelled();
  };

  // Everything that can fail before hours are spent is checked first.
  const client = await deps.client();
  const directory = deps.directoryBaseUrl();
  if (!directory) throw new Error("ADE's account service isn't configured on this computer, so it can't sign the new machine in.");
  if (!(await deps.getAccountToken())) throw new Error("Sign in to ADE on this computer first. The new machine joins your account.");
  if (!(await client.hasTemplate())) throw new Error(CLOUD_CANT_MAKE_COMPUTER_MESSAGE);
  checkCancelled();
  const logger = deps.logger ?? {};
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // The person's provider sign-ins, read before anything is recorded: a slow
  // or cancelled read leaves no half-made create behind. An unreadable vault
  // gives none; the machine is still made and asks to sign in like before.
  const minAdeVersion = cloudMinAdeVersion(deps.minAdeVersion?.() ?? null);
  // The async wrapper also catches a throw before the read starts. Only the
  // error's name is logged: its message could quote a vault value.
  const signInEnv: Record<string, string> = await (async () => (await deps.machineEnv?.()) ?? {})().catch((error: unknown) => {
    logger.warn?.("cloud.machine_env_read_failed", { error: error instanceof Error ? error.name : typeof error });
    return {};
  });
  const machineEnv = {
    ...signInEnv,
    ...(minAdeVersion ? { ADE_MIN_VERSION: minAdeVersion } : {}),
  };
  checkCancelled();
  // On disk before the request goes out: whatever happens to the answer, the
  // box carries this request id and the next start can find it.
  // If ADE cannot write down that it is making a box, it does not make one:
  // a quit before the answer would leave a box nothing can find.
  try {
    deps.pendingCreates?.begin(requestId, Date.now());
  } catch (error) {
    logger.warn?.("cloud.machine_create_not_recorded", { error: errorText(error) });
    throw new Error("ADE couldn't save a note of the machine it's about to make, so it didn't make one. Check that ADE can write to its folder, then try again.");
  }
  progress("creating", `Making ${name} on ADE Cloud…`);
  let instance: CloudInstance;
  try {
    instance = await client.createInstance({
      name,
      type: cloudInstanceType(rawArgs.kind),
      resources: { cpu: shape.cpu, memory: shape.memoryGb },
      metadata: { ...options.metadata, created_by: "ade", ade_request_id: requestId },
      ...(Object.keys(machineEnv).length ? { env: machineEnv } : {}),
      // The box's wake URL: its brain requests it while it works, which keeps
      // the provider's idle sleep off it (cloudSleep.ts).
      publicPorts: [{ port: CLOUD_WAKE_PORT, label: CLOUD_WAKE_PORT_LABEL }],
    }, signal);
  } catch (error) {
    // A create that timed out or broke mid-way may still have made a box.
    // Find it by the tag ADE put on it and take it back off the provider; what
    // can't be confirmed stays recorded for the next start.
    const reconcileOnce = () => deps.pendingCreates
      ? reconcileCloudPendingCreate(
        client,
        deps.pendingCreates.list().find((record) => record.requestId === requestId)
          ?? { requestId, startedAt: Date.now(), instanceIds: [] },
        { store: deps.pendingCreates, logger, sleep },
      ).catch((reconcileError: unknown) => {
        logger.warn?.("cloud.machine_create_reconcile_failed", { requestId, error: errorText(reconcileError) });
        return null;
      })
      : Promise.resolve(null);
    let cleanup = await reconcileOnce();
    // A cancel stops ADE waiting, not the provider making the box: it can still
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
        // the provider can still be making the box for as long as its create
        // request runs. Keep looking in the background, past this answer,
        // until the request resolves; the next app start covers a quit.
        void (async () => {
          const followUntil = Date.now() + CANCELLED_CREATE_FOLLOW_MS;
          let followed: CloudReconcileResult | null = cleanup;
          while (followed && !followed.resolved && Date.now() < followUntil) {
            await sleep(CANCELLED_CREATE_FOLLOW_POLL_MS);
            followed = await reconcileOnce();
          }
          logger.info?.("cloud.cancelled_create_followed", { requestId, resolved: followed?.resolved ?? false });
        })().catch((followError: unknown) => {
          logger.warn?.("cloud.cancelled_create_follow_failed", { requestId, error: errorText(followError) });
        });
      }
      throw new CloudCreateCancelled(cleanup?.resolved
        ? undefined
        : "ADE stopped making the machine. If ADE Cloud still makes it, ADE deletes it as soon as it appears.");
    }
    if (cleanup && cleanup.unresolved.length) {
      throw new Error(`${errorText(error).replace(/\.$/, "")}. ADE Cloud may have made the box anyway and ADE couldn't delete it yet; it tries again when ADE next starts.`);
    }
    throw error;
  }
  deps.pendingCreates?.attach(requestId, instance.id);
  logger.info?.("cloud.machine_created", { instanceId: instance.id, kind: rawArgs.kind, shape: shape.id });
  return await bringCloudBoxIntoAde(deps, { client, instance, name, requestId, signal, progress, directory });
}

/**
 * Approves a machine's pending device sign-in (its `userCode`) for this
 * account, and resolves once the machine itself says it is signed in. One
 * seam for every way a machine joins: a new machine, a copy, a reconnect.
 *
 * - With a window (`approveInWindow`, the desktop): `/device/approve` with this
 *   computer's account mints a one-time link that a private window opens;
 *   nothing to tap unless the page stops on a consent click.
 * - Without one (`handOffApproval`, a brain on its own): the sign-in link goes
 *   to the person, who approves it wherever they are signed in to ADE.
 *
 * `onApprovalSent` fires before the account is asked: from then on the
 * machine may be signed in whatever this function answers.
 */
export async function approveCloudMachineSignIn(
  deps: Pick<CloudMachineCreatorDeps, "approveInWindow" | "handOffApproval" | "approveHeadless" | "selfApproval" | "getAccountToken" | "fetch" | "logger" | "sleep">,
  args: {
    userCode: string;
    name: string;
    instanceId: string;
    /** The create (or copy, move) this sign-in belongs to; a reconnect has none. */
    requestId?: string;
    /** A fresh code from the machine, after a headless approval claimed the first and failed. */
    restartSignIn?: () => Promise<string | null>;
    directory: string;
    signal?: AbortSignal;
    readSignedIn: () => Promise<boolean>;
    onApprovalSent: () => void;
    progress: (stage: CloudCreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) => void;
  },
): Promise<void> {
  const { userCode, name, instanceId, directory, signal, readSignedIn, progress } = args;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetcher: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const logger = deps.logger ?? {};
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const checkCancelled = () => {
    if (signal?.aborted) throw new CloudCreateCancelled();
  };
  // Nobody here to approve: the person does, from the link. The code is
  // left pending (not claimed by /device/approve), so the phone's own
  // approval flow can take it.
  const handOff = async (code: string) => {
    if (!deps.handOffApproval) throw new Error("ADE has no window here to approve the machine's sign-in.");
    args.onApprovalSent();
    const url = `${directory.replace(/\/+$/, "")}/device?user_code=${encodeURIComponent(code)}`;
    deps.handOffApproval({ url, userCode: code, name });
    progress("approve_elsewhere", `Approve ${name} joining your account: open the link on your phone or in a browser signed in to ADE.`, instanceId, url);
    const approveDeadline = Date.now() + APPROVE_ELSEWHERE_TIMEOUT_MS;
    for (;;) {
      checkCancelled();
      if (await readSignedIn()) break;
      if (Date.now() > approveDeadline) throw new Error(`Nobody approved ${name} joining your account in 10 minutes.`);
      await sleep(POLL_MS);
    }
  };
  if (!deps.approveInWindow) {
    const headless = deps.approveHeadless;
    const selfApproved = Boolean(headless && args.requestId && deps.selfApproval)
      && await deps.selfApproval!({ instanceId, requestId: args.requestId! }).catch((error: unknown) => {
        logger.warn?.("cloud.self_approval_check_failed", { instanceId, requestId: args.requestId, error: errorText(error) });
        return false;
      });
    if (!headless || !selfApproved) return await handOff(userCode);
    progress("signing_in", `Approving ${name} with this machine's ADE sign-in…`, instanceId);
    try {
      await approveWithTicket(({ url, mode, signal: windowSignal }) =>
        // The approval page (mode "browser") needs a person's own sign-in.
        mode === "ticket" ? headless({ url, signal: windowSignal }) : Promise.resolve("closed" as const));
      logger.info?.("cloud.self_approval_signed_in", { instanceId, requestId: args.requestId });
      return;
    } catch (error) {
      checkCancelled();
      logger.warn?.("cloud.self_approval_failed", { instanceId, requestId: args.requestId, error: errorText(error) });
      // The approval may have landed (a page can end on an unclear title)
      // with the box still collecting its session; a fresh code now would
      // kill that sign-in, so give it the same grace a signed-in page gets.
      const graceDeadline = Date.now() + SIGN_IN_FINISH_TIMEOUT_MS;
      for (;;) {
        checkCancelled();
        if (await readSignedIn()) return;
        if (Date.now() > graceDeadline) break;
        await sleep(POLL_MS);
      }
      // /device/approve claimed the first code, so the link needs a new one.
      const fresh = await args.restartSignIn?.().catch((restartError: unknown) => {
        logger.warn?.("cloud.sign_in_restart_failed", { instanceId, error: errorText(restartError) });
        return null;
      });
      if (!fresh) throw error;
      return await handOff(fresh);
    }
  }
  await approveWithTicket(deps.approveInWindow);

  async function approveWithTicket(openWindow: NonNullable<CloudMachineCreatorDeps["approveInWindow"]>): Promise<void> {
    const token = await deps.getAccountToken();
    if (!token) throw new Error("Sign in to ADE on this computer first. The machine joins your account.");
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
      args.onApprovalSent();
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
      if (approveController.signal.aborted) throw new Error("ADE's account service didn't answer in time to approve the machine's sign-in. Try again.");
      throw new Error(`ADE couldn't reach its account service to approve the machine's sign-in: ${errorText(approveError)}`);
    } finally {
      clearTimeout(approveTimer);
      signal?.removeEventListener("abort", onCancelApprove);
    }
    checkCancelled();
    const ticketUrl = typeof body?.url === "string" && /^https:\/\//.test(body.url) ? body.url : null;
    const refusal = typeof body?.error === "string" ? body.error : null;
    let window: { url: string; mode: CloudApprovalMode };
    if (response.ok && ticketUrl) {
      window = { url: ticketUrl, mode: "ticket" };
    } else if (response.status === 503 && refusal === "unavailable") {
      // The account service can't mint a one-time ticket (no Clerk backend
      // key). The code is still pending, so its own approval page works:
      // the person confirms once, in ADE's browser session.
      logger.warn?.("cloud.approve_ticket_unavailable", { instanceId });
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
          if (await readSignedIn()) return true;
          await sleep(POLL_MS);
        }
        return false;
      })();
      const windowOutcome = openWindow({
        ...window,
        title: `Sign in ${name}`,
        signal: stopWatching.signal,
        onNeedsPerson: () => progress("confirm_in_window", `Confirm in the window that opened to let ${name} use your account.`, instanceId),
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
            if (await readSignedIn()) break;
            if (Date.now() > finishDeadline) throw new Error(`${name} was approved but didn't finish signing in.`);
            await sleep(POLL_MS);
          }
        } else if (!(await readSignedIn())) {
          throw new Error(first.outcome === "closed"
            ? `The sign-in window was closed before ${name} was approved.`
            : `${name}'s sign-in didn't finish in time.`);
        }
      }
    } finally {
      stopWatching.abort();
      signal?.removeEventListener("abort", onCancelWatch);
    }
  }
}

/**
 * Waits for a signed-in box's row in the account list and gives it `name`.
 * The row appears with the box's first publish, a moment before its relay
 * route does; connecting in that moment fails, so it waits for a route. A box
 * that isn't ready by the deadline is still a signed-in machine: the caller
 * keeps watching the account list for it.
 */
export async function waitForCloudAccountRow(
  deps: Pick<CloudMachineCreatorDeps, "listAccountMachines" | "renameMachine" | "logger" | "sleep">,
  args: { client: CloudProvider; instanceId: string; name: string; requestId: string; signal?: AbortSignal },
): Promise<{ machineKey: string | null; joined: boolean; renamed: boolean }> {
  const { client, instanceId, name, requestId, signal } = args;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger = deps.logger ?? {};
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
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
      logger.info?.("cloud.machine_join_cancelled", { instanceId, requestId });
      throw new CloudCreateCancelled(`You stopped waiting. "${name}" had already signed in, so ADE kept it: it appears under Your computers when it's ready.`);
    }
    if (!machineKey) {
      const read = await client.exec(instanceId, MACHINE_KEY_COMMAND).catch((error: unknown) => {
        warnOnce("cloud.machine_key_read_failed", { instanceId, error: errorText(error) });
        return null;
      });
      machineKey = read?.stdout.trim() || null;
      // On the box itself, so every computer on the account can tell which
      // row is this box, whatever it is named later.
      if (machineKey) await recordCloudMachineKey(client, instanceId, machineKey, logger);
    }
    if (machineKey) {
      const listed = await deps.listAccountMachines().catch((error: unknown) => {
        warnOnce("cloud.account_machines_read_failed", { instanceId, error: errorText(error) });
        return null;
      });
      const row = listed?.machines.find((machine) => machine.machineKey === machineKey) ?? null;
      if (row && !renamed) {
        try {
          await deps.renameMachine(machineKey, name);
          renamed = true;
        } catch (error) {
          logger.warn?.("cloud.machine_rename_failed", { instanceId, error: errorText(error) });
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
  if (!renamed) logger.warn?.("cloud.machine_rename_gave_up", { instanceId, joined, hasMachineKey: machineKey != null });
  if (!joined) logger.warn?.("cloud.machine_join_pending", { instanceId, hasMachineKey: machineKey != null });
  return { machineKey, joined, renamed };
}

/**
 * Steps 2 to 6 for a box that exists on the provider and runs ADE's template:
 * wait for its brain, sign it in with this computer's account, wait for its
 * row, name it, and turn its sleep on. A new box and a copy (a fork, which
 * comes up signed out by design) both end here. A box that never signed in is
 * deleted on any failure; one that did is kept.
 */
export async function bringCloudBoxIntoAde(
  deps: CloudMachineCreatorDeps,
  args: {
    client: CloudProvider;
    instance: CloudInstance;
    name: string;
    requestId: string;
    signal?: AbortSignal;
    progress: (stage: CloudCreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) => void;
    directory: string;
  },
): Promise<CloudCreateMachineResult> {
  const { client, instance, name, requestId, signal, progress, directory } = args;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger = deps.logger ?? {};
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const checkCancelled = () => {
    if (signal?.aborted) throw new CloudCreateCancelled();
  };
  // Set once ADE asks the account to approve the box's sign-in. Before that the
  // box cannot be signed in to this account, so a failure may delete it
  // outright; after it, only the box's own answer decides.
  let approvalSent = false;
  try {
    checkCancelled();
    progress("waiting_for_brain", "Starting ADE on the new machine…", instance.id);
    const readAuth = () => readCloudBoxAuth(client, instance.id, signal);
    const auth = await waitForCloudBoxAuth(client, instance.id, { signal, sleep, machine: "the new machine" });
    checkCancelled();

    if (auth.signedIn !== true) {
      progress("signing_in", "Signing the new machine in to your account…", instance.id);
      const started = await startCloudBoxSignIn(client, instance.id, "login", signal);
      checkCancelled();
      const userCode = started.userCode;
      if (!userCode) {
        logger.warn?.("cloud.sign_in_no_code", { instanceId: instance.id, exitCode: started.exitCode });
        throw new Error("The new machine didn't start its sign-in.");
      }

      await approveCloudMachineSignIn(deps, {
        userCode,
        name,
        instanceId: instance.id,
        requestId,
        restartSignIn: async () => (await startCloudBoxSignIn(client, instance.id, "login", signal, { fresh: true })).userCode,
        directory,
        signal,
        readSignedIn: async () => (await readAuth())?.signedIn === true,
        onApprovalSent: () => { approvalSent = true; },
        progress,
      });
    }
    // Signed in: a real machine, kept from here on.
    deps.pendingCreates?.finish(requestId);
  } catch (error) {
    logger.warn?.("cloud.machine_setup_failed", { instanceId: instance.id, error: errorText(error) });
    const reasonFor = () => (signal?.aborted ? new CloudCreateCancelled().message : errorText(error));
    // A cancel or failure after approval may come after the box signed in: then
    // it is a real machine on the account, not a bill, and is kept. Asked
    // without the create's signal, which a cancel has already aborted.
    if (approvalSent) {
      const signedIn = await readCloudBoxSignedIn(client, instance.id, logger);
      if (signedIn === true) {
        deps.pendingCreates?.finish(requestId);
        logger.info?.("cloud.machine_kept_signed_in", { instanceId: instance.id, requestId });
        throw new Error(`${reasonFor()} "${name}" had already signed in, so ADE kept it: it's under Your computers. Delete it from its row if you don't want it.`);
      }
      if (signedIn === "unknown") {
        // Left on the pending list: the next start asks the box again and
        // deletes it only on a clear "signed out".
        throw new Error(`${reasonFor()} ADE couldn't tell whether "${name}" (${instance.id}) finished signing in, so it didn't delete it. If it shows as Not in ADE under Your computers, delete it from its row; ADE also checks again when it next starts.`);
      }
    }
    // A box that never signed in is only using hours: take it back off the provider.
    const deleted = await deleteCloudInstanceConfirmed(client, instance.id, { logger, sleep, reason: "create_failed" });
    // Kept on the pending list until the provider confirms: the next app start tries again.
    if (deleted) {
      logger.warn?.("cloud.half_made_box_deleted", { instanceId: instance.id, requestId });
      deps.pendingCreates?.finish(requestId);
    }
    // A request the cancel cut short reads as the cancel, not as its own error.
    const reason = reasonFor();
    throw new Error(deleted
      ? `${reason} ADE deleted the computer it made.`
      : `${reason} ADE couldn't confirm it deleted the box it made ("${name}", ${instance.id}). Delete it from its row under Your computers; ADE also tries again when it next starts.`);
  }

  progress("joining", `${name} is signed in. Adding it to your computers…`, instance.id);
  const { machineKey, joined, renamed } = await waitForCloudAccountRow(deps, { client, instanceId: instance.id, name, requestId, signal });
  // Signed in, so its brain is up: hand it its wake URL and let the provider sleep
  // it when nothing runs. A brain too old to keep itself awake stays awake;
  // the next pass (registerCloudIpc) tries again once it updates.
  if (machineKey) {
    await enableCloudSleep(client, instance.id, { afterMinutes: deps.sleepAfterMinutes?.() ?? undefined, logger });
  }
  return { instanceId: instance.id, machineKey, name, joined, renamed };
}

/**
 * The DAEX Cloud Mac: a cloud computer of a second kind, run on NoMac, beside
 * Agent 37's Linux computers (`provider.ts`). Docs: "The DAEX Cloud Mac" in
 * `docs/features/ade-cloud/README.md`.
 *
 * A Mac is a `cloud_computers` row like any computer (`provider = 'nomac'`,
 * `os = 'mac'`), so the plan's computer limit, the lane it holds, the idle
 * cleanup, the message queue and account deletion treat it as one. What is
 * different lives here:
 *
 * - **It exists only while it runs.** NoMac has no sleep: a stop deletes the
 *   Mac and keeps only its 20 GB drive, under the label `adem:<instanceId>`.
 *   A start (a wake) is a new Mac on the same drive. The row's
 *   `mac_session_id` is the Mac it has now; null while it is stopped.
 * - **`status` stays in the old words** (`starting`, `running`, `stopped`) so
 *   the meter, the tick and an older app read it as a computer that stops and
 *   starts; `mac_state` says more (`CloudMacStateName`).
 * - **The brain is started by the server.** NoMac takes no env and runs no
 *   script at start, so once a Mac is ready the server runs one boot job on
 *   it (`bootMac`), once per session: the brain on the drive starts, and a
 *   first boot also gets its launch's join code, worked out again from the
 *   launch's salt (never stored).
 * - **NoMac's own limits never surprise ADE.** Each session's time limit and
 *   spend cap are what the account's credits allow (at most
 *   `MAC_RUN_MINUTES`); its idle limit is as long as its time limit, so ADE's
 *   own idle stop (the brain, `mac_idle_stop_minutes`) always comes first;
 *   the tick extends a session that still has credits behind it, and wakes a
 *   kept drive for a minute before NoMac's 30 days without use.
 *
 * The provider router (`createComputerProvider`) is the seam: every caller
 * keeps one `CloudProvider`, and each call goes to Agent 37 or here by the
 * computer's id. A Linux-only action on a Mac is refused with
 * `mac_unsupported` and one sentence (`CLOUD_MAC_UNSUPPORTED_SENTENCES`).
 */

import {
  CLOUD_COMPUTER_UNAVAILABLE_SENTENCE,
  CLOUD_LAUNCH_JOIN_TTL_MS,
  CLOUD_MAC_SHAPE,
  CLOUD_MAC_START_FAILED_SENTENCES,
  CLOUD_MAC_STATE_SENTENCES,
  CLOUD_MAC_UNSUPPORTED,
  CLOUD_MAC_UNSUPPORTED_SENTENCES,
  type CloudComputerAction,
  type CloudExecResult,
  type CloudInstance,
  type CloudMacStartFailure,
  type CloudMacState,
  type CloudMacStateName,
} from "./contract";
import { sendOwnerAlert } from "./blocks";
import { macMode, macReaches } from "./macSwitch";
import { readCloudSettings } from "./settings";
import { MAC_COST_MICROS_PER_MINUTE, MAC_CREDIT_MILLI_PER_MINUTE, cloudSizeFor } from "./plans";
import { accountWithUnsettledPhones } from "./credits";
import { macBootJoinCode } from "./launches";
import { errorOf, nomac, type NomacAnswer } from "./phoneNomac";
import { CloudProviderError, TRY_AGAIN_CODE, createCloudProvider, type CloudCreateInput, type CloudProvider } from "./provider";
import { earnedLeftForLimits, extraActiveForLimits, includedMilliOf, logCloud, readSetting, reportCloudFailure, statusChangeStatements, type CloudEnv, type ComputerRow } from "./store";
import { sha256Hex } from "../sinkUtils";

/* ---- Numbers ---- */

/** A drive save past the account's 10 included drives: 1 cent per GB changed. */
export const MAC_DRIVE_SAVE_MICROS_PER_GB = 10_000;
/** The longest one session runs before the tick must extend it (and the most a start asks for). */
export const MAC_RUN_MINUTES = 240;
/** NoMac's spend cap per minute of the time limit: $0.90 an hour, so the time limit stops a Mac first. */
const MAC_SPEND_CAP_MICROS_PER_MINUTE = 15_000;
/** How long a start may wait in NoMac's line (its longest). */
const MAC_QUEUE_SECONDS = 3_600;
/** A start ADE holds itself (NoMac's line was full) gives up after this long. */
const MAC_OWN_QUEUE_MS = 60 * 60_000;
/** The tick extends a session whose time limit is this close. */
const MAC_EXTEND_WITHIN_MS = 20 * 60_000;
/** NoMac deletes a drive after 30 days with no session; ADE wakes a kept drive after this many. */
export const MAC_DRIVE_UPKEEP_DAYS = 25;
/** The most kept drives one daily run wakes for upkeep: five days of slack before NoMac's 30 covers 250 drives a run. */
const MAC_UPKEEP_PER_RUN = 50;
/** An upkeep session waits in NoMac's line at most this long (NoMac's shortest). */
const MAC_UPKEEP_QUEUE_SECONDS = 300;
/** A start waits while an upkeep session began this recently: its line (5 minutes), its run (2) and a minute. */
const MAC_UPKEEP_HOLD_MS = 8 * 60_000;
/** The most held starts one tick tries again. */
const MAC_RETRY_PER_TICK = 10;
/** NoMac's own idle stop: its longest (an hour). A brain gone silent leaves the Mac to it. */
const MAC_NOMAC_IDLE_SECONDS = 3_600;
/** A busy brain's use report runs a command on its Mac at most this often (well inside NoMac's hour). */
const MAC_TOUCH_EVERY_MS = 10 * 60_000;
/** The boot job's own limit; it returns once the brain answers, usually in seconds. */
const MAC_BOOT_TIMEOUT_S = 600;

const MAC_ID = /^mac[0-9a-f]{32}$/;
/**
 * The start of every NoMac label this Worker makes for a Mac's drive. Each
 * environment has its own (`MAC_LABEL_PREFIX`; production's is `adem:`), so a
 * development and a production Worker on one NoMac key never touch each
 * other's Macs: the orphan sweep, the webhook and the label reads match only
 * their own.
 */
const MAC_LABEL_PREFIX_DEFAULT = "adem:";
const MAC_LABEL_PREFIX_SHAPE = /^[a-z]{2,12}:$/;
function macLabelPrefix(env: Pick<CloudEnv, "MAC_LABEL_PREFIX">): string {
  const prefix = env.MAC_LABEL_PREFIX?.trim() ?? "";
  return MAC_LABEL_PREFIX_SHAPE.test(prefix) ? prefix : MAC_LABEL_PREFIX_DEFAULT;
}

const DAY_MS = 24 * 60 * 60_000;

/** The Mac's one size (`plans.ts`). */
export const MAC_SIZE = cloudSizeFor("mac", CLOUD_MAC_SHAPE.cpu, CLOUD_MAC_SHAPE.memoryGb)!;

/* ---- Ids and rows ---- */

export const looksLikeMacId = (id: string): boolean => MAC_ID.test(id);
export const macLabelOf = (env: Pick<CloudEnv, "MAC_LABEL_PREFIX">, instanceId: string): string => `${macLabelPrefix(env)}${instanceId}`;
/** The Mac a label of this environment names; null for any other label (another environment's included). */
export function instanceIdOfMacLabel(env: Pick<CloudEnv, "MAC_LABEL_PREFIX">, label: unknown): string | null {
  const prefix = macLabelPrefix(env);
  return typeof label === "string" && label.startsWith(prefix) && MAC_ID.test(label.slice(prefix.length)) ? label.slice(prefix.length) : null;
}

/**
 * A Mac's id, from its reservation's own pending id: a retried create of that
 * reservation names the same Mac, and a new reservation (a failed launch
 * started again keeps its request id) a new one, never a deleted row's.
 */
export async function macInstanceIdFor(pendingId: string): Promise<string> {
  return `mac${(await sha256Hex(`ade-cloud-mac:v2:${pendingId}`)).slice(0, 32)}`;
}

export const isMacRow = (row: Pick<ComputerRow, "provider"> | null | undefined): boolean => row?.provider === "nomac";

/** Every action the server refuses on this computer (`CloudInstance.unsupported`). */
export function unsupportedActionsOf(row: Pick<ComputerRow, "provider">): CloudComputerAction[] {
  return isMacRow(row) ? [...CLOUD_MAC_UNSUPPORTED] : [];
}

export function macUnsupportedError(action: CloudComputerAction): CloudProviderError {
  return new CloudProviderError(CLOUD_MAC_UNSUPPORTED_SENTENCES[action], "mac_unsupported", 409);
}

/** The computer's `status` for a Mac state: the words every app already reads. */
export function macStatusOf(state: CloudMacStateName): string {
  if (state === "running") return "running";
  if (state === "queued" || state === "starting") return "starting";
  return "stopped";
}

/* ---- NoMac's session ---- */

/** A Mac session as NoMac answers it (the fields ADE reads). */
export type MacSession = {
  id: string;
  state: string;
  label?: string | null;
  ready_at?: string | null;
  shutdown_at?: string | null;
  created_at?: string | null;
  failure_code?: string | null;
  end_reason?: string | null;
  activity?: { hard_deadline_at?: string | null } | null;
  cost?: { billed_seconds?: number; accrued_microunits?: string } | null;
  drive?: { used_bytes?: number | null; saved_version?: number | null } | null;
};

const isoMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export function macSessionOf(value: unknown): MacSession | null {
  const session = value as MacSession | null;
  return session && typeof session === "object" && typeof session.id === "string" && typeof session.state === "string" ? session : null;
}

const LIVE_SESSION_STATES = new Set(["queued", "provisioning", "starting", "ready", "stopping"]);
export const isLiveSession = (session: Pick<MacSession, "state">): boolean => LIVE_SESSION_STATES.has(session.state);

/**
 * What a session says about the Mac: its state, and why a start that never
 * became ready ended (null when it did, or isn't over).
 */
export function macStateOfSession(session: MacSession | null): { state: CloudMacStateName; failed: CloudMacStartFailure | null } {
  if (!session) return { state: "stopped", failed: null };
  switch (session.state) {
    case "queued": return { state: "queued", failed: null };
    case "provisioning":
    case "starting": return { state: "starting", failed: null };
    case "ready": return { state: "running", failed: null };
    case "stopping": return { state: "stopping", failed: null };
    default: {
      if (session.ready_at) return { state: "stopped", failed: null };
      const reason = `${session.failure_code ?? ""} ${session.end_reason ?? ""}`;
      return { state: "stopped", failed: /queue_expired|capacity_unavailable/.test(reason) ? "queue_expired" : /drive_unavailable|drive_not_found/.test(reason) ? "drive_lost" : "unavailable" };
    }
  }
}

async function call(env: CloudEnv, method: string, path: string, body?: unknown, idempotencyKey?: string, timeoutMs?: number): Promise<NomacAnswer> {
  // A timeout or a dropped connection: unknown, like a 5xx (callers treat 5xx as "may have happened").
  return nomac(env, method, `/api/v1${path}`, body, idempotencyKey, timeoutMs).catch((): NomacAnswer => ({ status: 504, body: null }));
}

/** What a call that asks NoMac to hold (`?wait=N`) may take: the wait and room for the answer. */
const waitTimeoutMs = (waitSeconds: number): number => (waitSeconds + 10) * 1000;

async function readSession(env: CloudEnv, sessionId: string): Promise<MacSession | null | "unreadable"> {
  const answer = await call(env, "GET", `/mac/sessions/${encodeURIComponent(sessionId)}`);
  if (answer.status === 404) return null;
  const session = macSessionOf(answer.body?.session);
  return answer.status === 200 && session ? session : "unreadable";
}

function providerFailure(event: string, answer: NomacAnswer, meta: Record<string, unknown>): CloudProviderError {
  const { code } = errorOf(answer);
  reportCloudFailure(`cloud.mac_${event}`, { ...meta, status: answer.status, code }, "cloud-mac");
  return new CloudProviderError(CLOUD_MAC_START_FAILED_SENTENCES.unavailable, "mac_busy", 503);
}

/* ---- The row's Mac columns ---- */

export type MacRow = ComputerRow;

function macMetadataOf(row: Pick<ComputerRow, "mac_metadata_json">): Record<string, string> {
  try {
    const parsed = row.mac_metadata_json ? JSON.parse(row.mac_metadata_json) as unknown : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** What `macStateForClient` reads of a row. */
export type MacFactsRow = Pick<ComputerRow, "provider" | "mac_state" | "mac_state_at" | "mac_start_failed" | "mac_drive_used_bytes" | "mac_drive_saved_at" | "status_changed_at">;

/** The Mac's state for clients (`CloudInstance.mac`). */
export function macStateForClient(row: MacFactsRow): CloudMacState {
  const state = (row.mac_state as CloudMacStateName | null) ?? "stopped";
  const failed = row.mac_start_failed as CloudMacStartFailure | null;
  const failedSentence = failed && Object.hasOwn(CLOUD_MAC_START_FAILED_SENTENCES, failed) ? CLOUD_MAC_START_FAILED_SENTENCES[failed] : null;
  return {
    state,
    since: row.mac_state_at ?? row.status_changed_at,
    message: state === "stopped" && failedSentence ? failedSentence : CLOUD_MAC_STATE_SENTENCES[state],
    ...(state === "stopped" && failedSentence && failed ? { startFailed: true, failure: failed } : {}),
    drive: {
      sizeGb: CLOUD_MAC_SHAPE.driveGb,
      usedGb: row.mac_drive_used_bytes == null ? null : Math.round((row.mac_drive_used_bytes / 1e9) * 10) / 10,
      savedAt: row.mac_drive_saved_at ?? null,
    },
  };
}

/** The row as a `CloudInstance`, as the rest of the server reads any computer. */
export function macInstanceOf(row: ComputerRow): CloudInstance {
  return {
    id: row.instance_id,
    name: row.name,
    status: row.status,
    template: null,
    type: "mac",
    region: null,
    resources: { cpu: CLOUD_MAC_SHAPE.cpu, memory: CLOUD_MAC_SHAPE.memoryGb, disk: CLOUD_MAC_SHAPE.driveGb },
    url: null,
    pastDue: false,
    created: Math.floor(row.created_at / 1000),
    statusReason: null,
    metadata: macMetadataOf(row),
    autoSleep: false,
    idleTimeoutSeconds: null,
    publicPorts: [],
  };
}

/**
 * A Mac the switch doesn't reach, as a client sees it (\`routes.ts\`): a plain
 * stopped computer with its lane facts and nothing of the Mac (no type, size,
 * \`os\` or \`mac\`), whose wake, start and send answer
 * \`CLOUD_COMPUTER_UNAVAILABLE_SENTENCE\`. Its drive stays under the cleanup clock.
 */
export function hiddenMacInstance(row: ComputerRow): CloudInstance {
  return {
    ...macInstanceOf(row),
    status: "stopped",
    type: null,
    resources: null,
    statusReason: { code: "computer_unavailable", message: CLOUD_COMPUTER_UNAVAILABLE_SENTENCE },
  };
}

/** The refusal of every wake of a hidden Mac. */
export function macUnavailableError(): CloudProviderError {
  return new CloudProviderError(CLOUD_COMPUTER_UNAVAILABLE_SENTENCE, "computer_unavailable", 409);
}

/**
 * Writes what a session says: the Mac columns, the session's own row (for the
 * cost report), and the computer's status with its meter (`statusChangeStatements`).
 * Safe to run twice and out of order: a session that isn't the row's current
 * one only settles its own record, never the computer.
 */
export function macObservedStatements(env: CloudEnv, row: ComputerRow, session: MacSession | null, now: number, reason: string, macId = row.instance_id): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (session) {
    const readyAt = isoMs(session.ready_at);
    const endedAt = isLiveSession(session) ? null : (isoMs(session.shutdown_at) ?? now);
    const billedSeconds = Math.max(0, Math.round(Number(session.cost?.billed_seconds ?? 0)));
    const costMicros = Math.max(0, Math.round(Number(session.cost?.accrued_microunits ?? 0)));
    statements.push(env.DB.prepare(`
      insert into cloud_mac_sessions (session_id, instance_id, user_id, created_at, ready_at, ended_at, end_reason, billed_seconds, cost_micros)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (session_id) do update set ready_at = coalesce(cloud_mac_sessions.ready_at, excluded.ready_at),
        ended_at = coalesce(cloud_mac_sessions.ended_at, excluded.ended_at), end_reason = coalesce(excluded.end_reason, cloud_mac_sessions.end_reason),
        billed_seconds = max(cloud_mac_sessions.billed_seconds, excluded.billed_seconds), cost_micros = max(cloud_mac_sessions.cost_micros, excluded.cost_micros)
    `).bind(session.id, macId, row.user_id, isoMs(session.created_at) ?? now, readyAt, endedAt, session.end_reason ?? session.failure_code ?? null, billedSeconds, costMicros));
    // An older session (a stop's late news, a retried webhook): its record only.
    if (row.mac_session_id !== session.id) return statements;
  } else if (row.mac_session_id != null) {
    // NoMac has no such session: it is over.
  }
  const { state, failed } = macStateOfSession(session);
  // A start ADE holds itself (no session yet) stays queued until the tick tries it again.
  if (!session && row.mac_state === "queued" && row.mac_session_id == null) return statements;
  const ended = !session || !isLiveSession(session);
  const driveUsed = session?.drive?.used_bytes ?? null;
  if (row.mac_state !== state || ended) {
    statements.push(env.DB.prepare(`
      update cloud_computers set mac_state = ?, mac_state_at = case when coalesce(mac_state, '') = ? then mac_state_at else ? end,
        mac_start_failed = ?, mac_session_id = case when ? then null else mac_session_id end,
        mac_last_session_at = case when ? then ? else mac_last_session_at end,
        mac_hard_deadline_at = case when ? then null else mac_hard_deadline_at end,
        mac_drive_used_bytes = coalesce(?, mac_drive_used_bytes)
      where instance_id = ? and coalesce(mac_session_id, '') = ?
    `).bind(state, state, now, ended ? failed : null, ended ? 1 : 0, ended ? 1 : 0, now, ended ? 1 : 0, driveUsed, row.instance_id, row.mac_session_id ?? ""));
  } else {
    const deadline = isoMs(session?.activity?.hard_deadline_at);
    if (deadline != null && deadline !== row.mac_hard_deadline_at) {
      statements.push(env.DB.prepare("update cloud_computers set mac_hard_deadline_at = ? where instance_id = ? and mac_session_id = ?").bind(deadline, row.instance_id, row.mac_session_id));
    }
  }
  // Ready: a Mac launch's longer join window (it covered NoMac's line) shrinks to a Linux computer's from now,
  // so a Mac that runs and never joins isn't kept awake as "joining" for the hour it no longer needs.
  if (state === "running" && row.mac_state !== "running") {
    statements.push(env.DB.prepare("update cloud_launches set join_expires_at = min(join_expires_at, ?) where instance_id = ? and state in ('joining', 'needs_approval') and join_expires_at is not null")
      .bind(now + CLOUD_LAUNCH_JOIN_TTL_MS, macId));
  }
  // A session NoMac ended itself is billed to its own end, not to when DAEX heard of it (a late webhook or tick).
  const endedAt = ended && session ? isoMs(session.shutdown_at) : null;
  const at = endedAt != null ? Math.max(Math.min(endedAt, now), row.awake_since ?? endedAt) : now;
  statements.push(...statusChangeStatements(env, row, macStatusOf(state), at, reason));
  row.mac_state = state;
  if (ended) row.mac_session_id = null;
  return statements;
}

/**
 * The whole Mac minutes the account's credits buy now: the plan's and the
 * earned ones left, at 500 a minute; with extra credits on, a full run.
 */
export async function macCreditMinutesLeft(env: CloudEnv, userId: string, now: number): Promise<number> {
  const { account, liveUsedMilli } = await accountWithUnsettledPhones(env, userId, now);
  if (!account || liveUsedMilli == null) return 0;
  if (extraActiveForLimits(account)) return MAC_RUN_MINUTES;
  const left = Math.max(0, includedMilliOf(account) - liveUsedMilli) + earnedLeftForLimits(account, liveUsedMilli);
  return Math.floor(left / MAC_CREDIT_MILLI_PER_MINUTE);
}

/* ---- Start, stop, delete ---- */

/** The session limits for a start or an extension: what the account's credits allow, at most `MAC_RUN_MINUTES`. */
function limitsFor(minutes: number) {
  return {
    max_duration_seconds: minutes * 60,
    // NoMac's longest. DAEX's own idle stop (the brain's, 5 minutes) comes first; while the brain is busy it
    // reports use and \`touchMac\` runs a command, which is what NoMac's idle clock counts. This is the backstop.
    idle_timeout_seconds: Math.min(minutes * 60, MAC_NOMAC_IDLE_SECONDS),
    spend_cap_microunits: String(minutes * MAC_SPEND_CAP_MICROS_PER_MINUTE),
  };
}

async function templateDriveFor(env: CloudEnv, row: Pick<ComputerRow, "channel">): Promise<string | null> {
  const channel = row.channel === "beta" ? "beta" : "stable";
  return (await readSetting(env, `mac_template_drive_${channel}`))?.trim() || (await readSetting(env, "mac_template_drive"))?.trim() || null;
}

/**
 * Starts a Mac for the row on its drive (its first: a copy of the channel's
 * template drive). NoMac's line full or at its Mac limit: the start is held
 * by DAEX (`mac_state = 'queued'`, no session) and the tick tries again, so
 * the person sees the queue, never an error. Answers the computer's status.
 *
 * Each start claims the row with a fresh `mac_start_token` and writes only
 * while it still holds it: a stop meanwhile (`stopMac` clears the token) wins,
 * and a session NoMac made for the lost start is stopped at once. `retry`
 * (the tick's held start) claims only a row still queued, so a stop between
 * the tick's read and its start is never undone. The token is also the
 * start's idempotency key: a start after a stop is a new start at NoMac, even
 * while the old session is still shutting down.
 */
async function startMac(env: CloudEnv, row: ComputerRow, now: number, macId = row.instance_id, { retry = false }: { retry?: boolean } = {}): Promise<string> {
  if (row.mac_session_id && !retry) {
    const current = await readSession(env, row.mac_session_id);
    if (current !== "unreadable" && current && isLiveSession(current) && current.state !== "stopping") {
      await env.DB.batch(macObservedStatements(env, row, current, now, "start_reused", macId));
      return macStatusOf(macStateOfSession(current).state);
    }
  }
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(`update cloud_computers set mac_start_token = ? where instance_id = ? and deleted_at is null${retry ? " and mac_state = 'queued' and mac_session_id is null" : ""}`)
    .bind(token, row.instance_id).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return retry ? "stopped" : macStatusOf((row.mac_state as CloudMacStateName | null) ?? "stopped");
  row.mac_start_token = token;
  const minutes = Math.min(MAC_RUN_MINUTES, await macCreditMinutesLeft(env, row.user_id, now));
  if (minutes < 1) throw new CloudProviderError("You're out of DAEX Cloud credits for this period.", "out_of_hours", 402);
  // A drive upkeep session may hold the label: `reuse` would hand the person that short session, so the start is
  // held and the tick starts it a minute later (`runMacTick`).
  const upkeep = await env.DB.prepare("select 1 as busy from cloud_mac_sessions where instance_id = ? and upkeep = 1 and coalesce(end_reason, '') <> 'drive_save' and ended_at is null and created_at > ? limit 1")
    .bind(row.instance_id, now - MAC_UPKEEP_HOLD_MS).first<{ busy: number }>();
  if (upkeep) return holdStart(env, row, now, "upkeep_running");
  const template = await templateDriveFor(env, row);
  const label = row.mac_label ?? macLabelOf(env, macId);
  const answer = await call(env, "POST", "/mac/sessions", {
    label,
    reuse: true,
    require_drive: true,
    queue_seconds: MAC_QUEUE_SECONDS,
    ...(template ? { access: { drive_from: template } } : {}),
    limits: limitsFor(minutes),
  }, `ade-mac-${macId}-${token}`);
  const session = macSessionOf(answer.body?.session);
  const { code } = errorOf(answer);
  if (answer.status < 300 && session) {
    const taken = await env.DB.prepare(`update cloud_computers set mac_session_id = ?, mac_label = ?, mac_start_failed = null,
      mac_hard_deadline_at = ? where instance_id = ? and mac_start_token = ?`).bind(session.id, label, now + minutes * 60_000, row.instance_id, token).run();
    if ((taken.meta?.changes ?? 0) !== 1) {
      // A stop (or a delete) landed while NoMac answered: the session it made is stopped, never billed.
      await call(env, "DELETE", `/mac/sessions/${encodeURIComponent(session.id)}?confirm=true`);
      logCloud("cloud.mac_start_overtaken", { instanceId: macId });
      return "stopped";
    }
    row.mac_session_id = session.id;
    row.mac_label = label;
    await env.DB.batch(macObservedStatements(env, row, session, now, "start", macId));
    logCloud("cloud.mac_started", { instanceId: macId, state: session.state, reused: answer.body?.reused === true });
    return macStatusOf(macStateOfSession(session).state);
  }
  // NoMac's line is full, or the account runs its most Macs: DAEX holds the start and the person sees the queue.
  if (code === "queue_full" || code === "session_limit_reached" || code === "capacity_unavailable" || answer.status === 429) {
    return holdStart(env, row, now, code ?? `http_${answer.status}`);
  }
  if (code === "insufficient_credit" || answer.status === 402) {
    await sendOwnerAlert(env, {
      key: `nomac_mac_credit:${new Date(now).toISOString().slice(0, 10)}`,
      kind: "nomac_credit_low",
      userId: null,
      subject: "DAEX Cloud: NoMac refused a Mac for credit",
      reason: "NoMac refused to start a DAEX Cloud Mac because its prepaid credit is gone. Add credit at nomac.app.",
    }, now);
  }
  throw providerFailure("start_failed", answer, { instanceId: macId });
}

/** A start DAEX holds (`mac_state = 'queued'`, status `starting`, unbilled) and the tick tries again; only while its start still holds the row. */
async function holdStart(env: CloudEnv, row: ComputerRow, now: number, why: string): Promise<string> {
  const [held] = await env.DB.batch([
    env.DB.prepare(`update cloud_computers set mac_state = 'queued', mac_state_at = case when mac_state = 'queued' then mac_state_at else ? end,
      mac_session_id = null, mac_start_failed = null where instance_id = ? and mac_start_token is ?`).bind(now, row.instance_id, row.mac_start_token ?? null),
  ]);
  if ((held?.meta?.changes ?? 0) !== 1) return "stopped";
  await env.DB.batch(statusChangeStatements(env, row, "starting", now, "start_held"));
  row.mac_state = "queued";
  logCloud("cloud.mac_start_held", { instanceId: row.instance_id, code: why });
  return "starting";
}

/** Stops the Mac it has now (its drive is saved as it goes). A Mac already gone is stopped. */
async function stopMac(env: CloudEnv, row: ComputerRow, now: number, reason: string): Promise<string> {
  // First: a start in flight loses its claim and stops the session it gets (`startMac`).
  await env.DB.prepare("update cloud_computers set mac_start_token = null where instance_id = ?").bind(row.instance_id).run();
  row.mac_start_token = null;
  if (!row.mac_session_id) {
    // A start ADE was still holding: it is called off.
    if (row.mac_state === "queued") {
      await env.DB.batch([
        env.DB.prepare("update cloud_computers set mac_state = 'stopped', mac_state_at = ? where instance_id = ? and mac_session_id is null").bind(now, row.instance_id),
        ...statusChangeStatements(env, row, "stopped", now, reason),
      ]);
      row.mac_state = "stopped";
    }
    return "stopped";
  }
  const sessionId = row.mac_session_id;
  // `confirm`: a stop ADE decided wins over a command another key sent in the last minutes.
  const answer = await call(env, "DELETE", `/mac/sessions/${encodeURIComponent(sessionId)}?confirm=true`);
  if (answer.status >= 400 && answer.status !== 404 && answer.status !== 410) {
    throw new CloudProviderError(CLOUD_MAC_STATE_SENTENCES.stopping, TRY_AGAIN_CODE, 503);
  }
  const after = await readSession(env, sessionId);
  const session = after === "unreadable" ? { id: sessionId, state: "stopping" } : after;
  // Billing stops at the stop ADE asked for: the meter closes now, whatever NoMac's shutdown takes.
  const statements = macObservedStatements(env, row, session, now, reason);
  if (session && isLiveSession(session)) {
    statements.push(env.DB.prepare("update cloud_computers set mac_state = 'stopping', mac_state_at = ? where instance_id = ? and mac_session_id = ?").bind(now, row.instance_id, sessionId));
    statements.push(...statusChangeStatements(env, row, "stopped", now, reason));
  }
  await env.DB.batch(statements);
  return "stopped";
}

/**
 * Deletes the Mac and its drive. NoMac refuses while a Mac of the label runs
 * or its last save still uploads (`label_in_use`, `label_busy`): the delete
 * stops it and answers `try_again`, so the caller's retry finishes it.
 */
async function deleteMac(env: CloudEnv, row: ComputerRow, now: number): Promise<void> {
  if (row.mac_session_id || row.mac_state === "queued") await stopMac(env, row, now, "delete");
  const label = row.mac_label ?? macLabelOf(env, row.instance_id);
  const answer = await call(env, "DELETE", `/labels/${encodeURIComponent(label)}`);
  if (answer.status >= 400 && answer.status !== 404) {
    const { code } = errorOf(answer);
    logCloud("cloud.mac_delete_waits", { instanceId: row.instance_id, code });
    throw new CloudProviderError("The Mac is still saving its drive. Try again in a minute.", TRY_AGAIN_CODE, 503);
  }
}

/* ---- The boot job ---- */

/** What the boot job runs: the drive's own boot script (the template puts it there; `infra/ade-cloud-mac/`). */
const MAC_BOOT_COMMAND = '"$HOME/drive/.daex/boot.sh"';
/** What an exec runs first, so `ade` and its home are the brain's. */
const MAC_EXEC_PRELUDE = '[ -f "$HOME/drive/.daex/env.sh" ] && . "$HOME/drive/.daex/env.sh"; ';

function bootEnvOf(row: Pick<ComputerRow, "mac_boot_env_json">): Record<string, string> {
  try {
    const parsed = row.mac_boot_env_json ? JSON.parse(row.mac_boot_env_json) as unknown : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/**
 * Starts DAEX on a ready Mac: once per session (the row's
 * `mac_booted_session` is the claim). A first boot gets its launch's join
 * code, worked out again from the launch (`macBootJoinCode`); later boots
 * need none, the brain on the drive is signed in. `ADE_MIN_VERSION` brings
 * the drive's brain up to the channel's release. A failed job gives the
 * claim back, so the tick tries again.
 */
export async function bootMac(env: CloudEnv, row: ComputerRow, sessionId: string, now: number): Promise<"booted" | "taken" | "failed"> {
  const claimed = await env.DB.prepare("update cloud_computers set mac_booted_session = ? where instance_id = ? and mac_session_id = ? and coalesce(mac_booted_session, '') <> ?")
    .bind(sessionId, row.instance_id, sessionId, sessionId).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return "taken";
  const bootEnv: Record<string, string> = {
    ...bootEnvOf(row),
    ADE_HOST_INSTANCE_ID: `cloud:${row.instance_id}`,
    ADE_CLOUD_INSTANCE_ID: row.instance_id,
    // Unset (production), the brain's own default: DAEX's account server. A test Worker names itself.
    ...(env.MAC_DIRECTORY_URL?.trim() ? { ADE_ACCOUNT_DIRECTORY_URL: env.MAC_DIRECTORY_URL.trim() } : {}),
  };
  const minVersion = (await readSetting(env, `mac_min_version_${row.channel === "beta" ? "beta" : "stable"}`))?.trim();
  if (minVersion && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(minVersion)) bootEnv.ADE_MIN_VERSION = minVersion;
  const launchId = bootEnv.ADE_LAUNCH_ID;
  if (launchId) {
    const code = await macBootJoinCode(env, launchId, row.instance_id, now);
    if (code) bootEnv.ADE_LAUNCH_JOIN = code;
    else delete bootEnv.ADE_LAUNCH_ID;
  }
  const answer = await call(env, "POST", `/mac/sessions/${encodeURIComponent(sessionId)}/jobs?wait=50`, {
    argv: ["/bin/bash", "-lc", MAC_BOOT_COMMAND],
    env: bootEnv,
    timeout_seconds: MAC_BOOT_TIMEOUT_S,
  }, `ade-mac-boot-${sessionId}`, waitTimeoutMs(50));
  const job = (answer.body?.job ?? answer.body) as { exit_code?: unknown; state?: unknown } | null;
  const failed = answer.status >= 400 || (typeof job?.exit_code === "number" && job.exit_code !== 0);
  if (failed) {
    await env.DB.prepare("update cloud_computers set mac_booted_session = null where instance_id = ? and mac_booted_session = ?").bind(row.instance_id, sessionId).run();
    reportCloudFailure("cloud.mac_boot_failed", { instanceId: row.instance_id, status: answer.status, exitCode: typeof job?.exit_code === "number" ? job.exit_code : null }, "cloud-mac");
    return "failed";
  }
  logCloud("cloud.mac_booted", { instanceId: row.instance_id, state: typeof job?.state === "string" ? job.state : null });
  return "booted";
}

/**
 * The Mac's brain is busy (\`POST /cloud/instances/:id/use\`): one empty command
 * at most every \`MAC_TOUCH_EVERY_MS\`, so NoMac's idle clock (commands, SSH,
 * the desktop; never a background service) doesn't stop it under a long build.
 * The claim is one conditional update, so two reports at once run one command.
 */
export async function touchMac(env: CloudEnv, row: ComputerRow, now: number): Promise<void> {
  if (!row.mac_session_id || row.mac_state !== "running") return;
  const claimed = await env.DB.prepare("update cloud_computers set mac_touched_at = ? where instance_id = ? and mac_session_id = ? and coalesce(mac_touched_at, 0) <= ?")
    .bind(now, row.instance_id, row.mac_session_id, now - MAC_TOUCH_EVERY_MS).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  const answer = await call(env, "POST", `/mac/sessions/${encodeURIComponent(row.mac_session_id)}/jobs`, { argv: ["/usr/bin/true"], timeout_seconds: 10 },
    `ade-mac-touch-${row.mac_session_id}-${now}`);
  if (answer.status >= 300) {
    // Given back, so the next report tries again.
    await env.DB.prepare("update cloud_computers set mac_touched_at = null where instance_id = ? and mac_touched_at = ?").bind(row.instance_id, now).run();
    reportCloudFailure("cloud.mac_touch_failed", { instanceId: row.instance_id, status: answer.status, code: errorOf(answer).code }, "cloud-mac");
  }
}

/** Runs a command on the running Mac as a NoMac job. A stopped Mac has nothing to run it on: `try_again` while it starts. */
async function execMac(env: CloudEnv, row: ComputerRow, command: string, timeoutMs = 60_000): Promise<CloudExecResult> {
  if (!row.mac_session_id || row.mac_state !== "running") {
    throw new CloudProviderError("The Mac isn't on. Start it, then try again.", TRY_AGAIN_CODE, 409);
  }
  const sessionId = row.mac_session_id;
  const timeoutSeconds = Math.max(5, Math.min(3_600, Math.ceil(timeoutMs / 1000)));
  let answer = await call(env, "POST", `/mac/sessions/${encodeURIComponent(sessionId)}/jobs?wait=${Math.min(50, timeoutSeconds)}`, {
    argv: ["/bin/bash", "-lc", `${MAC_EXEC_PRELUDE}${command}`],
    timeout_seconds: timeoutSeconds,
  }, `ade-mac-exec-${crypto.randomUUID()}`, waitTimeoutMs(50));
  const deadline = Date.now() + timeoutMs;
  const jobOf = (value: NomacAnswer) => (value.body?.job ?? value.body) as { id?: unknown; state?: unknown; exit_code?: unknown; stdout?: unknown; stderr?: unknown } | null;
  let job = jobOf(answer);
  while (answer.status < 400 && (job?.state === "running" || job?.state === "queued") && typeof job.id === "string" && Date.now() < deadline) {
    answer = await call(env, "GET", `/mac/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(job.id)}?wait=${Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)))}`, undefined, undefined, waitTimeoutMs(50));
    job = jobOf(answer);
  }
  if (answer.status >= 400 || typeof job?.exit_code !== "number") {
    throw new CloudProviderError("DAEX Cloud did not answer in time. Try again.", answer.status >= 400 ? errorOf(answer).code : "timeout", answer.status >= 400 ? 502 : 0);
  }
  return { exitCode: job.exit_code, stdout: typeof job.stdout === "string" ? job.stdout : "", stderr: typeof job.stderr === "string" ? job.stderr : "" };
}

/* ---- Create ---- */

/**
 * Makes a Mac for a reservation (`createComputer`). The pending row learns it
 * is a Mac first, so a create that dies after NoMac's answer is adopted by
 * the tick (`listMacInstances` lists a pending Mac with its request id). The
 * env the boot job will pass is kept without the join code.
 */
async function createMac(env: CloudEnv, input: CloudCreateInput): Promise<CloudInstance> {
  const requestId = input.metadata?.ade_request_id;
  if (!requestId) throw new CloudProviderError("DAEX Cloud couldn't make that Mac.", "bad_request", 400);
  // The reservation this create is for: a request id is only ever one account's, and one live row of it
  // (`reserveComputer` refuses both), so it names this account's own row.
  const pending = await env.DB.prepare("select * from cloud_computers where request_id = ? and deleted_at is null and instance_id like 'pending:%' limit 1")
    .bind(requestId).first<ComputerRow>();
  if (!pending) throw new CloudProviderError("DAEX Cloud couldn't make that Mac.", "bad_request", 409);
  // A retry of this create keeps the id it was given; a new reservation gets its own.
  const instanceId = macMetadataOf(pending).ade_mac_instance_id ?? await macInstanceIdFor(pending.instance_id);
  if (!MAC_ID.test(instanceId)) throw new CloudProviderError("DAEX Cloud couldn't make that Mac.", "bad_request", 409);
  const { ADE_LAUNCH_JOIN: _join, ...keptEnv } = input.env ?? {};
  const metadata = { ...(input.metadata ?? {}), ade_mac_instance_id: instanceId };
  const marked = await env.DB.prepare(`
    update cloud_computers set provider = 'nomac', os = 'mac', mac_label = ?, mac_state = 'queued', mac_state_at = ?,
      mac_metadata_json = ?, mac_boot_env_json = ?
    where instance_id = ? and deleted_at is null
  `).bind(macLabelOf(env, instanceId), Date.now(), JSON.stringify(metadata), JSON.stringify(keptEnv), pending.instance_id).run();
  if ((marked.meta?.changes ?? 0) === 0) throw new CloudProviderError("DAEX Cloud couldn't make that Mac.", "bad_request", 409);
  const row = await env.DB.prepare("select * from cloud_computers where instance_id = ?").bind(pending.instance_id).first<ComputerRow>();
  if (!row) throw new CloudProviderError("DAEX Cloud couldn't make that Mac.", "bad_request", 409);
  // The start writes on the pending row, keyed at NoMac by the Mac's own id: a retry reaches the same session.
  const status = await startMac(env, row, Date.now(), instanceId);
  return { ...macInstanceOf({ ...row, instance_id: instanceId, status }), status, metadata };
}

/* ---- Listing and the tick ---- */

/**
 * Every Mac as an instance, from the rows (no call to NoMac): the tick and
 * the lists read them like Agent 37's. A pending Mac whose create got a
 * session is listed by its own id and request tag, so the tick adopts it.
 */
export async function listMacInstances(env: CloudEnv): Promise<CloudInstance[]> {
  const rows = await env.DB.prepare("select * from cloud_computers where provider = 'nomac' and deleted_at is null").all<ComputerRow>();
  const out: CloudInstance[] = [];
  for (const row of rows.results ?? []) {
    if (row.instance_id.startsWith("pending:")) {
      const id = macMetadataOf(row).ade_mac_instance_id;
      if (id && MAC_ID.test(id) && row.mac_session_id) out.push({ ...macInstanceOf({ ...row, instance_id: id }), status: macStatusOf((row.mac_state as CloudMacStateName | null) ?? "starting") });
      continue;
    }
    out.push(macInstanceOf(row));
  }
  return out;
}

/** The Mac row for an id, or null for any other computer. */
async function macRowOf(env: CloudEnv, id: string): Promise<ComputerRow | null> {
  if (!MAC_ID.test(id)) return null;
  const row = await env.DB.prepare("select * from cloud_computers where instance_id = ? and deleted_at is null").bind(id).first<ComputerRow>();
  return isMacRow(row) ? row : null;
}

/**
 * Reads the Mac a row has now and writes what changed, then boots it when it
 * just became ready. The webhook and the tick both run it; it is safe twice.
 */
export async function syncMac(env: CloudEnv, row: ComputerRow, now: number, reason: string): Promise<void> {
  if (!row.mac_session_id) return;
  const session = await readSession(env, row.mac_session_id);
  if (session === "unreadable") return;
  const statements = macObservedStatements(env, row, session, now, reason);
  if (statements.length) await env.DB.batch(statements);
  if (session && session.state === "ready" && row.mac_booted_session !== session.id) {
    await bootMac(env, { ...row, mac_session_id: session.id }, session.id, now);
  }
}

/**
 * The tick's Mac part, before the computers are read (`cron.ts`): every live
 * Mac read once from NoMac (a missed webhook can't leave one running or
 * billed); a ready Mac with no boot booted; a session near its time limit
 * extended while the account has credits; a start ADE held tried again (an
 * hour at most); a Mac whose account the switch no longer reaches stopped;
 * and NoMac sessions of labels with no live Mac stopped.
 */
export async function runMacTick(env: CloudEnv, now: number): Promise<void> {
  if (!env.NOMAC_API_KEY?.trim()) return;
  const rows = (await env.DB.prepare("select * from cloud_computers where provider = 'nomac' and deleted_at is null and instance_id not like 'pending:%' and (mac_session_id is not null or mac_state = 'queued')").all<ComputerRow>()).results ?? [];
  const settings = await readCloudSettings(env);
  const mode = await macMode(env, settings);
  // Off with nothing live: no NoMac call at all.
  if (mode === "off" && rows.length === 0) return;
  let retries = 0;
  const reached = new Map<string, Promise<boolean>>();
  const reaches = (userId: string): Promise<boolean> => {
    let answer = reached.get(userId);
    if (!answer) {
      answer = macReaches(env, userId, settings);
      reached.set(userId, answer);
    }
    return answer;
  };
  for (const row of rows) {
    try {
      if (!await reaches(row.user_id)) {
        // The switch went back: the Mac stops, its drive stays under the normal cleanup clock, nothing bills after.
        await stopMac(env, row, now, "mac_switch_off");
        continue;
      }
      if (!row.mac_session_id) {
        if (now - (row.mac_state_at ?? now) > MAC_OWN_QUEUE_MS) {
          await env.DB.batch([
            env.DB.prepare("update cloud_computers set mac_state = 'stopped', mac_state_at = ?, mac_start_failed = 'queue_expired' where instance_id = ? and mac_session_id is null").bind(now, row.instance_id),
            ...statusChangeStatements(env, row, "stopped", now, "mac_queue_expired"),
          ]);
        } else if (retries++ < MAC_RETRY_PER_TICK) {
          await startMac(env, row, now, row.instance_id, { retry: true });
        }
        continue;
      }
      await syncMac(env, row, now, "seen_by_tick");
      if (row.mac_session_id && row.mac_state === "running" && row.mac_hard_deadline_at != null && row.mac_hard_deadline_at - now < MAC_EXTEND_WITHIN_MS) {
        await extendMac(env, row, now);
      }
    } catch (error) {
      reportCloudFailure("cloud.mac_tick_failed", { code: error instanceof CloudProviderError ? error.code : "unknown" }, "cloud-mac");
    }
  }
  if (mode === "off") return;
  await stopOrphanSessions(env, now).catch((error: unknown) => {
    reportCloudFailure("cloud.mac_orphans_failed", { message: error instanceof Error ? error.message : "unknown" }, "cloud-mac");
  });
}

/** Raises a running session's time limit and spend cap by what the account's credits allow now. None left: ADE's zero stop ends it. */
async function extendMac(env: CloudEnv, row: ComputerRow, now: number): Promise<void> {
  const minutes = Math.min(MAC_RUN_MINUTES, await macCreditMinutesLeft(env, row.user_id, now));
  if (minutes < 1 || !row.mac_session_id) return;
  const answer = await call(env, "POST", `/mac/sessions/${encodeURIComponent(row.mac_session_id)}/extend`, { minutes, spend_cap_microunits: String(minutes * MAC_SPEND_CAP_MICROS_PER_MINUTE) },
    `ade-mac-extend-${row.mac_session_id}-${row.mac_hard_deadline_at ?? 0}`);
  const session = macSessionOf(answer.body?.session);
  const deadline = isoMs(session?.activity?.hard_deadline_at) ?? (answer.status < 300 ? (row.mac_hard_deadline_at ?? now) + minutes * 60_000 : null);
  if (answer.status >= 300 || deadline == null) {
    reportCloudFailure("cloud.mac_extend_failed", { instanceId: row.instance_id, status: answer.status, code: errorOf(answer).code }, "cloud-mac");
    return;
  }
  await env.DB.prepare("update cloud_computers set mac_hard_deadline_at = ? where instance_id = ? and mac_session_id = ?").bind(deadline, row.instance_id, row.mac_session_id).run();
}

/** A NoMac Mac with ADE's label and no Mac row that has it (a create lost before its row, a deleted computer): stopped. */
async function stopOrphanSessions(env: CloudEnv, now: number): Promise<void> {
  const answer = await call(env, "GET", "/mac/sessions?limit=100");
  if (answer.status !== 200) return;
  const sessions = (Array.isArray(answer.body?.sessions) ? answer.body.sessions as unknown[] : []).map(macSessionOf);
  for (const session of sessions) {
    if (!session || !isLiveSession(session) || session.state === "stopping") continue;
    const instanceId = instanceIdOfMacLabel(env, session.label);
    if (!instanceId) continue;
    const created = isoMs(session.created_at) ?? now;
    // A start in flight writes its session just after NoMac answers it: only older ones are orphans.
    if (now - created < 5 * 60_000) continue;
    // A row's own session, or DAEX's drive upkeep (it ends by its own two-minute limit).
    const owner = await env.DB.prepare(`select 1 as held from cloud_computers where provider = 'nomac' and deleted_at is null and mac_session_id = ?
      union all select 1 from cloud_mac_sessions where session_id = ? and upkeep = 1 limit 1`).bind(session.id, session.id).first<{ held: number }>();
    if (owner) continue;
    await call(env, "DELETE", `/mac/sessions/${encodeURIComponent(session.id)}?confirm=true`);
    reportCloudFailure("cloud.mac_orphan_stopped", { instanceId }, "cloud-mac");
  }
}

/**
 * The daily upkeep: a Mac lane kept with its drive unused for
 * `MAC_DRIVE_UPKEEP_DAYS` gets a short session so NoMac's 30-day rule never
 * deletes a drive DAEX still keeps. DAEX pays (`upkeep = 1`), the person is
 * never billed (the row's session stays its own, so the meter never opens).
 * The drive counts as used only once NoMac says a session reached ready: each
 * run first reads the upkeep sessions it started before, and a drive whose
 * upkeep never ran (NoMac's line, a failure) is tried again the next day.
 */
export async function runMacDriveUpkeep(env: CloudEnv, now: number): Promise<number> {
  if (!env.NOMAC_API_KEY?.trim()) return 0;
  await settleUpkeepSessions(env, now);
  const due = await env.DB.prepare(`
    select c.instance_id, c.user_id, c.mac_label from cloud_computers c
    where c.provider = 'nomac' and c.deleted_at is null and c.instance_id not like 'pending:%' and c.mac_session_id is null
      and coalesce(c.mac_state, 'stopped') = 'stopped' and coalesce(c.mac_last_session_at, c.created_at) < ?
      and not exists (select 1 from cloud_mac_sessions u where u.instance_id = c.instance_id and u.upkeep = 1 and u.ended_at is null
        and coalesce(u.end_reason, '') <> 'drive_save')
    order by coalesce(c.mac_last_session_at, c.created_at) limit ?
  `).bind(now - MAC_DRIVE_UPKEEP_DAYS * DAY_MS, MAC_UPKEEP_PER_RUN).all<{ instance_id: string; user_id: string; mac_label: string | null }>();
  let started = 0;
  for (const row of due.results ?? []) {
    const label = row.mac_label ?? macLabelOf(env, row.instance_id);
    const answer = await call(env, "POST", "/mac/sessions", {
      label, reuse: true, require_drive: true, queue_seconds: MAC_UPKEEP_QUEUE_SECONDS,
      limits: { max_duration_seconds: 120, idle_timeout_seconds: 60, spend_cap_microunits: String(3 * MAC_COST_MICROS_PER_MINUTE) },
    }, `ade-mac-upkeep-${row.instance_id}-${new Date(now).toISOString().slice(0, 10)}`);
    const session = macSessionOf(answer.body?.session);
    if (answer.status >= 300 || !session) {
      reportCloudFailure("cloud.mac_upkeep_failed", { instanceId: row.instance_id, status: answer.status, code: errorOf(answer).code }, "cloud-mac");
      continue;
    }
    // Its cost is its two-minute ceiling, for the owner's report: NoMac never reports a session that isn't a row's own.
    // The drive's clock moves only when this session is seen ready (`settleUpkeepSessions`).
    await env.DB.prepare(`insert into cloud_mac_sessions (session_id, instance_id, user_id, created_at, cost_micros, upkeep) values (?, ?, ?, ?, ?, 1) on conflict (session_id) do nothing`)
      .bind(session.id, row.instance_id, row.user_id, now, 2 * MAC_COST_MICROS_PER_MINUTE).run();
    started += 1;
  }
  if (started) logCloud("cloud.mac_upkeep", { started });
  return started;
}

/** The upkeep sessions not yet settled: ready ones move their drive's clock, ended ones close; nothing else counts as use. */
async function settleUpkeepSessions(env: CloudEnv, now: number): Promise<void> {
  const open = await env.DB.prepare(`
    select session_id, instance_id from cloud_mac_sessions
    where upkeep = 1 and ended_at is null and coalesce(end_reason, '') <> 'drive_save' order by created_at limit ?
  `).bind(MAC_UPKEEP_PER_RUN * 2).all<{ session_id: string; instance_id: string }>();
  for (const entry of open.results ?? []) {
    const session = await readSession(env, entry.session_id);
    if (session === "unreadable") continue;
    const readyAt = session ? isoMs(session.ready_at) : null;
    const ended = !session || !isLiveSession(session);
    const statements: D1PreparedStatement[] = [];
    if (readyAt != null) {
      statements.push(env.DB.prepare("update cloud_computers set mac_last_session_at = max(coalesce(mac_last_session_at, 0), ?) where instance_id = ?").bind(readyAt, entry.instance_id));
    }
    if (ended) {
      statements.push(env.DB.prepare("update cloud_mac_sessions set ended_at = ?, ready_at = coalesce(ready_at, ?), end_reason = coalesce(end_reason, ?) where session_id = ?")
        .bind(session ? (isoMs(session.shutdown_at) ?? now) : now, readyAt, readyAt != null ? "upkeep" : "upkeep_never_ran", entry.session_id));
    }
    if (statements.length) await env.DB.batch(statements);
  }
}

/**
 * A NoMac webhook about a Mac (`mac.*`, `drive.*`): the label names the
 * computer, and the Mac is read again from NoMac rather than trusted from
 * the delivery, so a repeat or an out-of-order one does nothing new. An
 * unknown label or session is nothing. `drive.deleted` is checked against
 * NoMac's label before the drive is called lost.
 */
export async function handleMacWebhook(env: CloudEnv, type: string, data: Record<string, unknown> | null, now: number): Promise<void> {
  const session = macSessionOf(data?.session);
  const drive = data?.drive && typeof data.drive === "object" ? data.drive as Record<string, unknown> : null;
  const label = session?.label ?? (typeof data?.label === "string" ? data.label : null) ?? (typeof drive?.label === "string" ? drive.label : null);
  const instanceId = instanceIdOfMacLabel(env, label);
  if (!instanceId) return;
  const row = await macRowOf(env, instanceId);
  if (!row) return;
  if (type === "drive.saved") {
    const used = typeof drive?.used_bytes === "number" ? drive.used_bytes : null;
    await env.DB.prepare("update cloud_computers set mac_drive_used_bytes = coalesce(?, mac_drive_used_bytes), mac_drive_saved_at = ? where instance_id = ?").bind(used, now, instanceId).run();
    const charged = typeof drive?.charge_microunits === "string" || typeof drive?.charge_microunits === "number" ? Math.max(0, Math.round(Number(drive.charge_microunits))) : 0;
    if (charged > 0) {
      await env.DB.prepare("insert into cloud_mac_sessions (session_id, instance_id, user_id, created_at, ended_at, end_reason, cost_micros, upkeep) values (?, ?, ?, ?, ?, 'drive_save', ?, 1) on conflict (session_id) do nothing")
        .bind(`save:${instanceId}:${typeof drive?.version === "number" ? drive.version : now}`, instanceId, row.user_id, now, now, charged).run();
    }
    return;
  }
  if (type === "drive.deleted") {
    const read = await call(env, "GET", `/labels/${encodeURIComponent(row.mac_label ?? macLabelOf(env, instanceId))}`);
    const macs = read.body?.macs && typeof read.body.macs === "object" ? read.body.macs as Record<string, unknown> : null;
    // Only plain evidence: the label is unknown (404), or its answer names a drive field that is empty. Any other
    // shape keeps the drive (a wrong "lost" would refuse every start of a healthy one); the next start shows the truth.
    const gone = read.status === 404 || (read.status === 200 && macs != null && Object.hasOwn(macs, "drive") && macs.drive == null);
    if (!gone) return;
    await env.DB.prepare("update cloud_computers set mac_start_failed = 'drive_lost', mac_state = 'stopped', mac_state_at = ? where instance_id = ? and mac_session_id is null").bind(now, instanceId).run();
    reportCloudFailure("cloud.mac_drive_lost", { instanceId }, "cloud-mac");
    return;
  }
  // `mac.ready`, `mac.ending`, `mac.ended`, …: read the Mac it has now.
  await syncMac(env, row, now, `webhook_${type.replace(/[^a-z_.]/g, "").slice(0, 24)}`);
}

/* ---- The router ---- */

/**
 * The one `CloudProvider` every caller holds: each call goes to Agent 37 or
 * to the Mac by the computer's id (a Mac id is `mac` + 32 hex and its row
 * says `nomac`; an id of that shape with any other row is Agent 37's). A
 * create goes by its type. Null with neither key set.
 */
export function createComputerProvider(env: CloudEnv, fetcher: typeof fetch = fetch): CloudProvider | null {
  const linuxKey = env.AGENT37_API_KEY?.trim();
  const hasMac = Boolean(env.NOMAC_API_KEY?.trim());
  if (!linuxKey && !hasMac) return null;
  const linux = linuxKey ? createCloudProvider(linuxKey, fetcher) : null;
  const noLinux = (): never => {
    throw new CloudProviderError("DAEX Cloud can't do that right now. Try again in a moment.", "no_provider_key", 503);
  };
  const L = (): CloudProvider => linux ?? noLinux();
  const rows = new Map<string, Promise<ComputerRow | null>>();
  const macOf = (id: string): Promise<ComputerRow | null> => {
    if (!hasMac || !MAC_ID.test(id)) return Promise.resolve(null);
    let found = rows.get(id);
    if (!found) {
      found = macRowOf(env, id);
      rows.set(id, found);
    }
    return found;
  };
  // Every write changes the row: the next call reads it again.
  const fresh = async (id: string): Promise<ComputerRow | null> => {
    rows.delete(id);
    return macOf(id);
  };
  const refuse = (action: CloudComputerAction) => async (id: string, ..._rest: unknown[]) => {
    if (await macOf(id)) throw macUnsupportedError(action);
    return null;
  };

  const router: CloudProvider = {
    async listInstances() {
      const [linuxList, macs] = await Promise.all([linux ? linux.listInstances() : Promise.resolve([]), hasMac ? listMacInstances(env) : Promise.resolve([])]);
      return [...linuxList, ...macs];
    },
    async getInstance(id) {
      const row = await fresh(id);
      if (!row) return L().getInstance(id);
      await syncMac(env, row, Date.now(), "seen");
      return macInstanceOf((await fresh(id)) ?? row);
    },
    async createInstance(input) {
      if ((input.type as string) === "mac") {
        if (!hasMac) noLinux();
        return createMac(env, input);
      }
      return L().createInstance(input);
    },
    async deleteInstance(id) {
      const row = await fresh(id);
      if (!row) return L().deleteInstance(id);
      await deleteMac(env, row, Date.now());
      rows.delete(id);
    },
    async sleepInstance(id) {
      const row = await fresh(id);
      if (!row) return L().sleepInstance(id);
      const status = await stopMac(env, row, Date.now(), "sleep");
      rows.delete(id);
      return status;
    },
    async startInstance(id) {
      const row = await fresh(id);
      if (!row) return L().startInstance(id);
      // Every wake path ends here (a person's start, the queue, timed and event wakes): a hidden Mac never starts.
      if (!await macReaches(env, row.user_id)) throw macUnavailableError();
      const status = await startMac(env, row, Date.now());
      rows.delete(id);
      return status;
    },
    async stopInstance(id) {
      const row = await fresh(id);
      if (!row) return L().stopInstance(id);
      const status = await stopMac(env, row, Date.now(), "stop");
      rows.delete(id);
      return status;
    },
    async updateInstance(id, template) {
      await refuse("update")(id);
      return L().updateInstance(id, template);
    },
    async resizeInstance(id, resources) {
      await refuse("resize")(id);
      return L().resizeInstance(id, resources);
    },
    async createBackup(id) {
      await refuse("backup")(id);
      return L().createBackup(id);
    },
    async setAutoSleep(id, policy) {
      // A Mac always stops when its work stops: nothing to set.
      if (await macOf(id)) return;
      return L().setAutoSleep(id, policy);
    },
    async addPublicPort(id, input) {
      await refuse("public_ports")(id);
      return L().addPublicPort(id, input);
    },
    async forkInstance(id, input) {
      await refuse("copy")(id);
      return L().forkInstance(id, input);
    },
    async signedUrl(id, input) {
      await refuse("signed_url")(id);
      return L().signedUrl(id, input);
    },
    async setInstanceName(id, name) {
      // The name lives on the row (the route writes it); NoMac keeps none.
      if (await macOf(id)) return;
      return L().setInstanceName(id, name);
    },
    async setInstanceMetadata(id, metadata) {
      const row = await fresh(id);
      if (!row) return L().setInstanceMetadata(id, metadata);
      // Merged, as the launch's own keys (`ade_launch_id`, `ade_request_id`) must outlive a later write of the machine key.
      await env.DB.prepare("update cloud_computers set mac_metadata_json = ? where instance_id = ?")
        .bind(JSON.stringify({ ...macMetadataOf(row), ...metadata }), id).run();
      rows.delete(id);
    },
    async setNetworkPolicy(id, policy) {
      const row = await fresh(id);
      if (!row) return L().setNetworkPolicy(id, policy);
      // NoMac has no network switch: a block stops the Mac, and a blocked account can't start one.
      if (policy === "deny-all") await stopMac(env, row, Date.now(), "blocked");
      rows.delete(id);
    },
    usage: (window) => (linux ? linux.usage(window) : Promise.resolve({ instances: [] })),
    async instanceEvents(id) {
      if (await macOf(id)) return [];
      return L().instanceEvents(id);
    },
    billing: () => L().billing(),
    hasTemplate: (name) => L().hasTemplate(name),
    async instanceHealth(id) {
      if (await macOf(id)) return null;
      return L().instanceHealth(id);
    },
    async instanceMetrics(id) {
      if (await macOf(id)) return { diskBytes: null, memoryBytes: null, limits: { diskBytes: CLOUD_MAC_SHAPE.driveGb * 1e9, memoryBytes: CLOUD_MAC_SHAPE.memoryGb * 1e9 } };
      return L().instanceMetrics(id);
    },
    async exec(id, command, timeoutMs) {
      const row = await fresh(id);
      if (!row) return L().exec(id, command, timeoutMs);
      return execMac(env, row, command, timeoutMs);
    },
  };
  return router;
}

/** The account's Macs, stopped (a tester taken off the list). Their drives stay. */
export async function stopAccountMacs(env: CloudEnv, userId: string, now: number): Promise<void> {
  const rows = (await env.DB.prepare("select * from cloud_computers where user_id = ? and provider = 'nomac' and deleted_at is null and (mac_session_id is not null or mac_state = 'queued')").bind(userId).all<ComputerRow>()).results ?? [];
  for (const row of rows) {
    await stopMac(env, row, now, "mac_access_removed").catch((error: unknown) => {
      reportCloudFailure("cloud.mac_access_stop_failed", { code: error instanceof CloudProviderError ? error.code : "unknown" }, "cloud-mac");
    });
  }
}

/** Every Mac drive of a deleted account goes (`accountDeletion.ts`). Throws while NoMac still saves one, so the deletion is retried. */
export async function forgetAccountMacs(env: CloudEnv, userId: string, now: number): Promise<void> {
  const rows = (await env.DB.prepare("select * from cloud_computers where user_id = ? and provider = 'nomac'").bind(userId).all<ComputerRow>()).results ?? [];
  for (const row of rows) {
    if (row.deleted_at == null) {
      await deleteMac(env, row, now);
      continue;
    }
    // A closed row keeps its status (\`deleted\`) and power log: only its label (the drive) goes at NoMac.
    const answer = await call(env, "DELETE", `/labels/${encodeURIComponent(row.mac_label ?? macLabelOf(env, row.instance_id))}`);
    if (answer.status >= 400 && answer.status !== 404) {
      throw new CloudProviderError("The Mac is still saving its drive. Try again in a minute.", TRY_AGAIN_CODE, 503);
    }
  }
}

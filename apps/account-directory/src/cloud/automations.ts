import { sha256Hex } from "../sinkUtils";
import { connectGitHubSentence, DEFAULT_AGENT_LIMITS, githubRepoVisibility, notifyAccount, readVaultFacts, type CloudAgentLimits, type RelayEnv, type VaultFacts } from "./accountVault";
import { isTimeZone, nextFireAt, parseCron } from "./automationSchedule";
import {
  AUTOMATION_WEBHOOK_UNTRUSTED_NOTICE,
  CLOUD_AUTOMATION_DEFAULT_RUNS_PER_HOUR,
  CLOUD_AUTOMATION_HOOK_HEADERS,
  CLOUD_AUTOMATION_PROMPT_VARIABLE,
  CLOUD_AUTOMATION_RUN_STAGE,
  CLOUD_LAUNCH_MAX_PROMPT_CHARS,
  CLOUD_PATHS,
  type CloudAutomationRegistered,
  type CloudAutomationRegistration,
  type CloudAutomationRun,
  type CloudAutomationRunState,
  type CloudAutomationSpec,
  type CloudAutomationSummary,
  type CloudAutomationTrigger,
  type CloudLaunchRecord,
  type CloudServerLaunchRequest,
  type CloudTierId,
} from "./contract";
import { UNREADABLE_REQUEST_MESSAGE, cloudAccessAllows, fail, json, readJson } from "./http";
import { githubOriginOf, startServerLaunch, type LaunchRouteDeps } from "./launches";
import { laneFactsOf, laneFactsOfRow, markKeepLaneStatement, mergeLaneFacts, namesLane, unmarkKeepLaneStatement } from "./lanesWithoutComputer";
import { pushAllWork, putBackToRest, type WakeRecord } from "./planCleanup";
import { cloudSizeForTier } from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";
import { deleteComputer, logCloud, ownedComputer, reportCloudFailure } from "./store";

/**
 * Automations whose home is ADE Cloud (C9, docs/plans/cloud-6/c9-automations-spec.md).
 *
 * A rule's home is one of the person's computers, or ADE Cloud. For a cloud
 * home no computer starts it (every brain reads the home as "not here"); the
 * brain that saved the home registers the rule here, compiled into a run
 * spec, and this module watches its trigger:
 *
 * - a schedule: the stored next fire time, read by the minute cron in the
 *   same one indexed statement that finds runs needing the server;
 * - a custom webhook: the webhook relay forwards each delivery here, signed
 *   with a per-hook key (`handleAutomationDelivery`);
 * - Run now.
 *
 * Each run is one server launch (`startServerLaunch`, launch id = run id,
 * made by `automation`), under the person's agent limits. One run at a time
 * per rule with at most one waiting, a storm stop (`max_runs_per_hour`), and
 * after the run its computer is freed (work pushed, the lane kept as a lane
 * without a computer) unless the rule keeps it. A run that can't start fails
 * before anything is made, says why, and tells the person.
 *
 * Nothing here polls a machine: the cron reads D1 once a minute, and a
 * computer's launch reports (`noteAutomationLaunchProgress`) move a run on.
 */

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const HOOK_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RULES_PER_ACCOUNT = 50;
const MAX_RUNS_PER_HOUR_CAP = 60;
/**
 * History kept per rule; older ended runs go when a new one is recorded. A
 * run (not a skipped trigger) younger than `RUNS_COUNTED_MS` always stays:
 * the storm stop and the daily computer limit count those rows.
 */
const RUNS_KEPT_PER_RULE = 50;
const RUNS_COUNTED_MS = 25 * 60 * 60_000;
const RUNS_LISTED = 20;
/** A schedule missed by less than this gets one catch-up run; older is skipped and recorded. */
const CATCH_UP_MS = 60 * 60_000;
/** A run whose computer hasn't said anything this long is stopped (its work pushed, its lane kept). */
const RUN_MAX_MS = 6 * 60 * 60_000;
/** A start the Worker never finished (its request died) is tried again after this. The launch id makes it safe. */
const START_STALE_MS = 10 * 60_000;
/** A start that keeps waiting for ADE Cloud (no provider, or it answered 503) fails after this. */
const START_GIVE_UP_MS = 60 * 60_000;
/** A finishing claim older than this was lost (the Worker died): the next tick takes it again. */
const FINISH_CLAIM_MS = 20 * 60_000;
const CRON_ROWS = 40;
const FINISHES_PER_TICK = 3;
/** The relay signs at send time, so a forward older than this is a replay. */
const HOOK_MAX_SKEW_MS = 5 * 60_000;
const MAX_TRIGGER_BODY_CHARS = 20_000;
const EMAIL_EVERY_MS = 24 * 60 * 60_000;
const HOOK_KEY_LABEL = "ade.cloud.automation-hook.v1";

const MAX_BODY_FIELDS = 40;

type RuleRow = {
  user_id: string;
  rule_id: string;
  enabled: number;
  project_origin: string;
  name: string;
  spec_json: string;
  rule_version: string;
  spec_digest: string;
  cron: string | null;
  timezone: string | null;
  next_fire_at: number | null;
  starts_at: number;
  hook_id: string | null;
  hook_salt: string | null;
  limits_json: string | null;
  git_ok: number | null;
  repo_visibility: string | null;
  max_runs_per_hour: number;
  keep_computer: number;
  paused_reason: string | null;
  paused_at: number | null;
  emailed_at: number | null;
  created_at: number;
  updated_at: number;
};

type RunRow = {
  run_id: string;
  user_id: string;
  rule_id: string;
  trigger_kind: CloudAutomationTrigger["kind"];
  trigger_summary: string | null;
  trigger_json: string | null;
  delivery_id: string | null;
  state: CloudAutomationRunState;
  reason: string | null;
  outcome: string | null;
  lane_id: string | null;
  instance_id: string | null;
  computer: string | null;
  claimed_at: number | null;
  not_before: number | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
};

/**
 * What a run's trigger brought: the prompt reads it, and a queued run keeps
 * it. `fields` holds the values of the `{{trigger.body.*}}` paths the prompt
 * names, read from the whole body when it came (the kept `body` is cut short).
 */
type TriggerFacts = {
  kind: CloudAutomationTrigger["kind"];
  summary: string | null;
  body?: string | null;
  method?: string | null;
  fields?: Record<string, string>;
  firedAt: number;
  deliveryId?: string | null;
};

/** What a run needs from the request (or the cron) that started it. */
export type AutomationDeps = {
  provider: CloudProvider | null;
  now: number;
  createComputer: LaunchRouteDeps["createComputer"];
};

const notFound = () => fail("not_found", "ADE Cloud has no such automation.", 404);
const badRequest = (message: string) => fail("bad_request", message, 400);
const OPEN_STATES = "('queued', 'starting', 'running', 'finishing')";
const ACTIVE_STATES = "('starting', 'running')";

/* ---- The spec ---- */

function shortString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function parseTrigger(value: unknown): CloudAutomationTrigger | string {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (raw?.kind === "manual") return { kind: "manual" };
  if (raw?.kind === "schedule") {
    const cron = shortString(raw.cron, 120);
    if (!cron || !parseCron(cron)) return "That schedule isn't one ADE can read.";
    if (!isTimeZone(raw.timezone)) return "That schedule's time zone isn't one ADE knows.";
    return { kind: "schedule", cron, timezone: raw.timezone };
  }
  if (raw?.kind === "webhook") {
    if (typeof raw.hookId !== "string" || !HOOK_ID.test(raw.hookId)) return "That webhook can't be used.";
    const maxAge = raw.maxAgeMinutes == null ? null : Number(raw.maxAgeMinutes);
    if (maxAge != null && (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 7 * 24 * 60)) return "That webhook's age limit can't be used.";
    return { kind: "webhook", hookId: raw.hookId, ...(maxAge ? { maxAgeMinutes: maxAge } : {}) };
  }
  // Everything else watches something on one computer, or GitHub and Linear (not on ADE Cloud yet).
  return "ADE Cloud runs a rule on a schedule, a custom webhook or Run now. Other triggers run on one of your computers.";
}

/** The registration's body as one, or the sentence that says what's wrong. */
export function parseRegistration(body: Record<string, unknown>): CloudAutomationRegistration | string {
  const ruleVersion = shortString(body.ruleVersion, 64);
  if (!ruleVersion) return "A registration needs the rule's version.";
  if (typeof body.enabled !== "boolean") return "A registration says whether the rule is on.";
  const startsAt = body.startsAt == null ? null : Number(body.startsAt);
  if (startsAt != null && !Number.isFinite(startsAt)) return UNREADABLE_REQUEST_MESSAGE;
  const spec = body.spec && typeof body.spec === "object" ? body.spec as Record<string, unknown> : null;
  const name = shortString(spec?.name, 200);
  if (!spec || !name) return "A registration needs the rule's name.";
  const project = spec.project && typeof spec.project === "object" ? spec.project as Record<string, unknown> : null;
  const origin = githubOriginOf(project?.origin);
  if (!origin) return "Only rules in GitHub repositories can run on ADE Cloud.";
  if (!Array.isArray(spec.triggers) || spec.triggers.length === 0 || spec.triggers.length > 8) return "A rule on ADE Cloud needs a trigger.";
  const triggers: CloudAutomationTrigger[] = [];
  for (const entry of spec.triggers) {
    const trigger = parseTrigger(entry);
    if (typeof trigger === "string") return trigger;
    triggers.push(trigger);
  }
  if (triggers.filter((trigger) => trigger.kind === "schedule").length > 1) return "A rule on ADE Cloud takes one schedule.";
  if (triggers.filter((trigger) => trigger.kind === "webhook").length > 1) return "A rule on ADE Cloud takes one webhook.";
  if (!cloudSizeForTier(spec.sizeId)) return "That size isn't one ADE Cloud offers.";
  const chat = spec.chat && typeof spec.chat === "object" ? spec.chat as Record<string, unknown> : null;
  const provider = typeof chat?.provider === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(chat.provider) ? chat.provider : null;
  const modelId = typeof chat?.modelId === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(chat.modelId) ? chat.modelId : null;
  const permissions = typeof chat?.permissions === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(chat.permissions) ? chat.permissions : null;
  const effort = chat?.effort == null ? null : typeof chat.effort === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(chat.effort) ? chat.effort : undefined;
  const prompt = typeof chat?.prompt === "string" ? chat.prompt : null;
  if (!provider || !modelId || !permissions || effort === undefined || !prompt?.trim()) return "A rule on ADE Cloud needs its model, permissions and prompt.";
  // Room for the trigger's own text the server adds.
  if (prompt.length > CLOUD_LAUNCH_MAX_PROMPT_CHARS - MAX_TRIGGER_BODY_CHARS - 2_000) return "This rule's prompt is too long for ADE Cloud.";
  const lane = spec.lane && typeof spec.lane === "object" ? spec.lane as Record<string, unknown> : null;
  const from = lane?.from == null ? null : typeof lane.from === "string" && /^[A-Za-z0-9._/@+-]{1,250}$/.test(lane.from) ? lane.from : undefined;
  if (from === undefined) return "That branch name can't be used.";
  const limits = spec.limits && typeof spec.limits === "object" ? spec.limits as Record<string, unknown> : null;
  const perHour = limits?.maxRunsPerHour == null ? null : Number(limits.maxRunsPerHour);
  if (perHour != null && (!Number.isInteger(perHour) || perHour < 1 || perHour > MAX_RUNS_PER_HOUR_CAP)) return `A rule runs at most ${MAX_RUNS_PER_HOUR_CAP} times an hour.`;
  if (spec.timezone != null && !isTimeZone(spec.timezone)) return "That rule's time zone isn't one ADE knows.";
  // Only `trigger.*` and `run.*` (and the clock) are variables on a computer; other braces are the prompt's own text.
  const unknown = promptVariables(prompt).find((variable) => /^(?:trigger|run)\./.test(variable) && !CLOUD_AUTOMATION_PROMPT_VARIABLE.test(variable));
  if (unknown) return `ADE Cloud can't fill {{${unknown}}} in this rule's prompt.`;
  return {
    ruleVersion,
    enabled: body.enabled,
    startsAt,
    spec: {
      name,
      project: { origin },
      triggers,
      sizeId: spec.sizeId as CloudTierId,
      chat: { provider, modelId, ...(effort ? { effort } : {}), permissions, ...(chat?.fast === true ? { fast: true } : {}), prompt },
      lane: { from },
      limits: { maxRunsPerHour: perHour, keepComputer: limits?.keepComputer === true },
      ...(typeof spec.timezone === "string" ? { timezone: spec.timezone } : {}),
      ...(spec.channel === "beta" ? { channel: "beta" as const } : {}),
    },
  };
}

/** The stored spec, put through the registration's own checks; null (logged) when it isn't one. */
function specOf(row: RuleRow): CloudAutomationSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.spec_json);
  } catch (error) {
    reportCloudFailure("cloud.automation_spec_unreadable", { ruleId: row.rule_id, error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
  const checked = parsed && typeof parsed === "object"
    ? parseRegistration({ ruleVersion: row.rule_version, enabled: row.enabled === 1, spec: parsed })
    : "not an object";
  if (typeof checked === "string") {
    reportCloudFailure("cloud.automation_spec_unreadable", { ruleId: row.rule_id, error: "shape" });
    return null;
  }
  return checked.spec;
}

/**
 * The agent limits the vault gave at the last registration, or null when
 * they are unknown (the vault never answered): then nothing unattended spends.
 */
function limitsOf(row: RuleRow): CloudAgentLimits | null {
  if (!row.limits_json) return null;
  try {
    return { ...DEFAULT_AGENT_LIMITS, ...(JSON.parse(row.limits_json) as Partial<CloudAgentLimits>) };
  } catch (error) {
    reportCloudFailure("cloud.automation_limits_unreadable", { ruleId: row.rule_id, error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

const PROMPT_VARIABLE = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** Every `{{variable}}` a prompt names. */
function promptVariables(prompt: string): string[] {
  return [...prompt.matchAll(PROMPT_VARIABLE)].map((match) => match[1]!);
}

/** A JSON body's value at a dotted path, as the desktop templates it: a string as is, anything else as JSON, missing as "". */
function bodyField(parsed: unknown, path: string): string {
  let cursor: unknown = parsed;
  for (const segment of path.split(".").filter(Boolean)) {
    if (cursor == null || typeof cursor !== "object") return "";
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor == null) return "";
  if (typeof cursor === "string") return cursor;
  try {
    return JSON.stringify(cursor) ?? "";
  } catch {
    return String(cursor);
  }
}

/** The body as JSON, or undefined when it isn't JSON. */
function parsedBody(body: string | null | undefined): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** The `{{trigger.body.*}}` values a prompt names, read from the whole body. */
function bodyFieldsFor(prompt: string, body: string): Record<string, string> {
  const paths = [...new Set(promptVariables(prompt).filter((variable) => variable.startsWith("trigger.body.")).map((variable) => variable.slice("trigger.body.".length)))];
  if (paths.length === 0) return {};
  const parsed = parsedBody(body);
  const fields: Record<string, string> = {};
  for (const path of paths.slice(0, MAX_BODY_FIELDS)) fields[path] = bodyField(parsed, path).slice(0, MAX_TRIGGER_BODY_CHARS);
  return fields;
}

/** `{{date}}` and `{{time}}` as the desktop writes them (`2026-11-11`, `09:05`), on the clock of `zone`. */
function clockIn(at: number, zone: string): { date: string; time: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

/**
 * The prompt of one run: the rule's, with the trigger's facts filled in the
 * way a computer fills them (`resolvePlaceholders`), or added below it when
 * the prompt names none. `{{date}}` and `{{time}}` read the scheduled time for
 * a schedule, else `now`, in the rule's zone.
 */
export function runPrompt(spec: CloudAutomationSpec, trigger: TriggerFacts, now: number): string {
  const body = parsedBody(trigger.body);
  const wholeBody = body !== undefined && typeof body === "object" && body !== null ? JSON.stringify(body) : trigger.body ?? "";
  const scheduleZone = spec.triggers.find((entry): entry is Extract<CloudAutomationTrigger, { kind: "schedule" }> => entry.kind === "schedule")?.timezone;
  const clock = clockIn(trigger.kind === "schedule" ? trigger.firedAt : now, spec.timezone ?? scheduleZone ?? "UTC");
  let used = false;
  const filled = spec.chat.prompt.replace(PROMPT_VARIABLE, (match, variable: string) => {
    if (variable === "date") return clock.date;
    if (variable === "time") return clock.time;
    if (!variable.startsWith("trigger.")) return match;
    used = true;
    if (variable === "trigger.type") return trigger.kind;
    if (variable === "trigger.method") return trigger.method ?? "";
    if (variable === "trigger.body") return wholeBody;
    if (variable.startsWith("trigger.body.")) {
      const path = variable.slice("trigger.body.".length);
      return trigger.fields?.[path] ?? bodyField(body, path);
    }
    return match;
  });
  const firedAt = new Date(trigger.firedAt).toISOString();
  const lines = trigger.kind === "webhook" ? [AUTOMATION_WEBHOOK_UNTRUSTED_NOTICE, "", filled] : [filled];
  if (!used) {
    lines.push("", `Trigger: ${trigger.kind}`, `Fired at: ${firedAt}`);
    if (trigger.summary) lines.push(`Summary: ${trigger.summary}`);
    if (trigger.body) lines.push("", "Delivery body:", trigger.body);
  }
  return lines.join("\n").slice(0, CLOUD_LAUNCH_MAX_PROMPT_CHARS);
}

/* ---- Reads ---- */

async function readRule(env: RelayEnv, userId: string, ruleId: string): Promise<RuleRow | null> {
  return await env.DB.prepare("select * from cloud_automations where user_id = ? and rule_id = ?").bind(userId, ruleId).first<RuleRow>();
}

async function readRun(env: RelayEnv, runId: string): Promise<RunRow | null> {
  return await env.DB.prepare("select * from cloud_automation_runs where run_id = ?").bind(runId).first<RunRow>();
}

function runOf(row: RunRow): CloudAutomationRun {
  return {
    runId: row.run_id,
    ruleId: row.rule_id,
    trigger: { kind: row.trigger_kind, summary: row.trigger_summary },
    state: row.state,
    reason: row.reason,
    laneId: row.lane_id,
    instanceId: row.instance_id,
    computer: row.computer === "freed" || row.computer === "kept" ? row.computer : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

function summaryOf(row: RuleRow, runs: RunRow[]): CloudAutomationSummary {
  return {
    ruleId: row.rule_id,
    name: row.name,
    projectOrigin: row.project_origin,
    enabled: row.enabled === 1,
    pausedReason: row.paused_reason === "storm" ? "storm" : null,
    ruleVersion: row.rule_version,
    nextFireAt: row.enabled === 1 ? row.next_fire_at : null,
    runs: runs.map(runOf),
  };
}

/* ---- The webhook forward's key ---- */

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function hmacHex(key: Uint8Array<ArrayBuffer>, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message)));
}

/** The directory's `CLOUD_CHAT_MASTER_KEY` as its 32 bytes, or null (reported) when it is missing or isn't one. */
function masterKey(env: RelayEnv): Uint8Array<ArrayBuffer> | null {
  const raw = env.CLOUD_CHAT_MASTER_KEY?.trim();
  if (!raw) return null;
  let master: Uint8Array<ArrayBuffer>;
  try {
    master = fromBase64(raw);
  } catch {
    reportCloudFailure("cloud.automation_master_key_invalid", { reason: "base64" });
    return null;
  }
  if (master.length !== 32) {
    reportCloudFailure("cloud.automation_master_key_invalid", { reason: "length" });
    return null;
  }
  return master;
}

/**
 * A hook's signing key, derived from the directory's own `CLOUD_CHAT_MASTER_KEY`
 * (no new secret) and the hook's random salt. The directory's D1 holds only
 * the salt, so a copy of it can't sign a delivery; the webhook relay keeps the
 * derived key (its `forward_secret`) to sign with. Null when the master key
 * is missing or invalid.
 */
async function hookKey(env: RelayEnv, row: Pick<RuleRow, "user_id" | "rule_id" | "hook_id" | "hook_salt">): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!row.hook_id || !row.hook_salt) return null;
  const master = masterKey(env);
  if (!master) return null;
  const hex = await hmacHex(master, [HOOK_KEY_LABEL, row.user_id, row.rule_id, row.hook_id, row.hook_salt].join("\n"));
  const key = new Uint8Array(new ArrayBuffer(32));
  for (let index = 0; index < 32; index += 1) key[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return key;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** The forward the relay needs, for a rule with a webhook trigger. */
async function forwardOf(env: RelayEnv, row: RuleRow, origin: string): Promise<CloudAutomationRegistered["forward"]> {
  const key = await hookKey(env, row);
  if (!key || !row.hook_id) return null;
  return {
    hookId: row.hook_id,
    // The owner is in the path, so a delivery finds its one row by the primary key
    // (the signature, keyed with the owner's id, still proves it).
    url: `${origin}${CLOUD_PATHS.automations}/${encodeURIComponent(row.rule_id)}/deliveries/${encodeURIComponent(row.user_id)}`,
    secret: toHex(key.buffer),
  };
}

/* ---- Registration ---- */

/**
 * What the vault says now, read with the registering brain's own token, as
 * the row's columns. A read that isn't answered keeps what was known.
 */
async function vaultColumns(facts: VaultFacts, origin: string, existing: RuleRow | null): Promise<Pick<RuleRow, "git_ok" | "limits_json" | "repo_visibility">> {
  const gitOk = facts.git === "ok" ? 1 : facts.git === "none" ? 0 : existing?.git_ok ?? null;
  const visibility = gitOk === 0
    ? await githubRepoVisibility(origin).then((value) => (value === "unknown" ? existing?.repo_visibility ?? null : value))
    : existing?.repo_visibility ?? null;
  return { git_ok: gitOk, repo_visibility: visibility, limits_json: facts.limits ? JSON.stringify(facts.limits) : existing?.limits_json ?? null };
}

async function handleRegister(request: Request, env: RelayEnv, userId: string, ruleId: string, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const registration = parseRegistration(body);
  if (typeof registration === "string") return badRequest(registration);
  const origin = new URL(request.url).origin;
  const existing = await readRule(env, userId, ruleId);
  // A brain that hasn't synced the newest rule must not put back an older one.
  if (existing && existing.rule_version > registration.ruleVersion) {
    return json({ ruleId, changed: false, current: false, nextFireAt: existing.next_fire_at, forward: await forwardOf(env, existing, origin) } satisfies CloudAutomationRegistered);
  }
  // The update track only moves up within one version: a Stable (or older) brain sending the
  // version a Beta brain sent never takes the rule back to the Stable image, which can't run it.
  const sameVersion = existing != null && registration.ruleVersion === existing.rule_version;
  const spec: CloudAutomationSpec = sameVersion && existing && specOf(existing)?.channel === "beta" && registration.spec.channel !== "beta"
    ? { ...registration.spec, channel: "beta" }
    : registration.spec;
  // Read on every registration (each version a brain sends, and each brain start), so a change of the
  // agent limits or the GitHub sign-in reaches rules that didn't change.
  const vault = await vaultColumns(await readVaultFacts(env, request.headers.get("authorization")), spec.project.origin, existing);
  const digest = await sha256Hex(JSON.stringify({ enabled: registration.enabled, startsAt: registration.startsAt ?? 0, spec }));
  // Only a real save (a newer version) turns a storm-paused rule back on; a brain's restart sends the same one.
  const newer = !existing || registration.ruleVersion > existing.rule_version;
  const unpausing = Boolean(existing?.paused_reason) && registration.enabled && newer;
  if (existing && existing.spec_digest === digest && !unpausing) {
    // Nothing of the rule changed. A newer version is still recorded, so the same version sent again
    // later (a brain's restart) never reads as a save that lifts a storm pause.
    if (newer || vault.git_ok !== existing.git_ok || vault.limits_json !== existing.limits_json || vault.repo_visibility !== existing.repo_visibility) {
      await env.DB.prepare(`
        update cloud_automations set git_ok = ?, limits_json = ?, repo_visibility = ?, rule_version = max(rule_version, ?), updated_at = ?
        where user_id = ? and rule_id = ?
      `).bind(vault.git_ok, vault.limits_json, vault.repo_visibility, registration.ruleVersion, now, userId, ruleId).run();
      logCloud("cloud.automation_facts_updated", { userId, ruleId });
    }
    return json({ ruleId, changed: false, current: true, nextFireAt: existing.next_fire_at, forward: await forwardOf(env, existing, origin) } satisfies CloudAutomationRegistered);
  }
  if (!existing) {
    const count = await env.DB.prepare("select count(*) as count from cloud_automations where user_id = ?").bind(userId).first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_RULES_PER_ACCOUNT) return fail("automation_limit", `ADE Cloud runs at most ${MAX_RULES_PER_ACCOUNT} automations for one account.`, 403);
  }
  const hook = spec.triggers.find((trigger): trigger is Extract<CloudAutomationTrigger, { kind: "webhook" }> => trigger.kind === "webhook") ?? null;
  if (hook && !masterKey(env)) return fail("unavailable", "ADE Cloud can't take webhooks right now. Try again soon.", 503);

  const schedule = spec.triggers.find((trigger): trigger is Extract<CloudAutomationTrigger, { kind: "schedule" }> => trigger.kind === "schedule") ?? null;
  const startsAt = Math.max(0, Math.round(registration.startsAt ?? 0));
  const nextFire = schedule && registration.enabled ? nextFireAt(schedule.cron, schedule.timezone, Math.max(now, startsAt)) : null;
  const hookSalt = hook ? (existing?.hook_id === hook.hookId && existing.hook_salt ? existing.hook_salt : crypto.randomUUID()) : null;
  const perHour = spec.limits?.maxRunsPerHour ?? CLOUD_AUTOMATION_DEFAULT_RUNS_PER_HOUR;
  try {
    await env.DB.prepare(`
      insert into cloud_automations (user_id, rule_id, enabled, project_origin, name, spec_json, rule_version, spec_digest, cron, timezone, next_fire_at,
        starts_at, hook_id, hook_salt, limits_json, git_ok, repo_visibility, max_runs_per_hour, keep_computer, paused_reason, paused_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)
      on conflict (user_id, rule_id) do update set project_origin = excluded.project_origin, name = excluded.name,
        spec_json = excluded.spec_json, rule_version = excluded.rule_version, spec_digest = excluded.spec_digest, cron = excluded.cron,
        timezone = excluded.timezone, next_fire_at = excluded.next_fire_at, starts_at = excluded.starts_at, hook_id = excluded.hook_id,
        hook_salt = excluded.hook_salt, limits_json = excluded.limits_json, git_ok = excluded.git_ok, repo_visibility = excluded.repo_visibility,
        max_runs_per_hour = excluded.max_runs_per_hour, keep_computer = excluded.keep_computer,
        -- A storm pause holds until a newer version (a real save) comes.
        enabled = case when cloud_automations.paused_reason is not null and excluded.rule_version <= cloud_automations.rule_version then 0 else excluded.enabled end,
        paused_reason = case when excluded.rule_version > cloud_automations.rule_version then null else cloud_automations.paused_reason end,
        paused_at = case when excluded.rule_version > cloud_automations.rule_version then null else cloud_automations.paused_at end,
        updated_at = excluded.updated_at
      where cloud_automations.rule_version <= excluded.rule_version
    `).bind(
      userId, ruleId, registration.enabled ? 1 : 0, spec.project.origin, spec.name, JSON.stringify(spec), registration.ruleVersion, digest,
      schedule?.cron ?? null, schedule?.timezone ?? null, nextFire, startsAt, hook?.hookId ?? null, hookSalt, vault.limits_json, vault.git_ok, vault.repo_visibility,
      perHour, spec.limits?.keepComputer ? 1 : 0, now, now,
    ).run();
  } catch (error) {
    // The one unique index besides the key: another of this account's rules holds this hook.
    if (error instanceof Error && /unique/i.test(error.message)) return fail("hook_taken", "Another of your automations on ADE Cloud already uses that webhook.", 409);
    throw error;
  }
  const saved = await readRule(env, userId, ruleId);
  // Deleted between the write and this read (an unregister at the same moment).
  if (!saved) return notFound();
  logCloud("cloud.automation_registered", { userId, ruleId, enabled: registration.enabled, schedule: Boolean(schedule), webhook: Boolean(hook) });
  return json({
    ruleId,
    changed: true,
    current: saved.rule_version === registration.ruleVersion,
    nextFireAt: saved.next_fire_at,
    forward: await forwardOf(env, saved, origin),
  } satisfies CloudAutomationRegistered);
}

/* ---- Runs ---- */

async function pruneRuns(env: RelayEnv, userId: string, ruleId: string, now: number): Promise<void> {
  // A run younger than `RUNS_COUNTED_MS` stays whatever the history cap says: the storm stop and the
  // daily computer limit count it. Skipped triggers (a storm makes many) don't count, so they can go.
  await env.DB.prepare(`
    delete from cloud_automation_runs where user_id = ? and rule_id = ? and state not in ${OPEN_STATES}
      and (state = 'skipped' or created_at < ?)
      and run_id not in (select run_id from cloud_automation_runs where user_id = ? and rule_id = ? order by created_at desc limit ?)
  `).bind(userId, ruleId, now - RUNS_COUNTED_MS, userId, ruleId, RUNS_KEPT_PER_RULE).run();
}

/** Tells the person, by push every time and by email at most once a day per rule. */
async function tell(env: RelayEnv, rule: RuleRow, title: string, body: string, now: number, email: boolean): Promise<void> {
  let sendEmail = false;
  if (email) {
    const claimed = await env.DB.prepare("update cloud_automations set emailed_at = ? where user_id = ? and rule_id = ? and (emailed_at is null or emailed_at < ?)")
      .bind(now, rule.user_id, rule.rule_id, now - EMAIL_EVERY_MS).run();
    sendEmail = (claimed.meta?.changes ?? 0) === 1;
  }
  await notifyAccount(env, rule.user_id, { title, body, email: sendEmail });
}

/**
 * Ends a run that is still open as failed, and says why. Given the rule, the
 * person hears (push, and an email at most once a day when `email`); given
 * only the run, the failure is only recorded (a rule deleted meanwhile, a cancel).
 */
async function failRun(
  env: RelayEnv,
  owner: { rule: RuleRow } | { run: Pick<RunRow, "user_id" | "rule_id"> },
  runId: string,
  reason: string,
  now: number,
  options: { email?: boolean; states?: string; unclaimDay?: boolean } = {},
): Promise<void> {
  const { user_id: userId, rule_id: ruleId } = "rule" in owner ? owner.rule : owner.run;
  // `unclaimDay`: no computer was made, so the run gives back the day's computer it claimed.
  const startedAt = options.unclaimDay ? "case when instance_id is null then null else started_at end" : "started_at";
  await env.DB.prepare(`update cloud_automation_runs set state = 'failed', reason = ?, started_at = ${startedAt}, ended_at = ?, updated_at = ? where run_id = ? and state in ${options.states ?? OPEN_STATES}`)
    .bind(reason, now, now, runId).run();
  logCloud("cloud.automation_run_failed", { userId, ruleId, runId });
  if ("rule" in owner) await tell(env, owner.rule, `"${owner.rule.name}" didn't run on ADE Cloud`, reason, now, options.email === true);
}

/**
 * Records a trigger that won't run, once per delivery: a repeat of a
 * delivery answers the row it made the first time.
 */
async function recordSkipped(env: RelayEnv, rule: RuleRow, trigger: TriggerFacts, reason: string, now: number): Promise<RunRow> {
  const runId = crypto.randomUUID();
  await env.DB.prepare(`
    insert or ignore into cloud_automation_runs (run_id, user_id, rule_id, trigger_kind, trigger_summary, trigger_json, delivery_id, state, reason, ended_at, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?, ?)
  `).bind(runId, rule.user_id, rule.rule_id, trigger.kind, trigger.summary, null, trigger.deliveryId ?? null, reason, now, now, now).run();
  // No body or fields kept: a skipped trigger never starts. And pruned here too:
  // a rule that is off or paused still takes deliveries, and only these come in then.
  await pruneRuns(env, rule.user_id, rule.rule_id, now);
  const row = (await readRun(env, runId)) ?? (trigger.deliveryId ? await readDelivery(env, rule, trigger.deliveryId) : null);
  if (!row) throw new Error("A skipped trigger's row was not written.");
  return row;
}

async function readDelivery(env: RelayEnv, rule: RuleRow, deliveryId: string): Promise<RunRow | null> {
  return await env.DB.prepare("select * from cloud_automation_runs where user_id = ? and rule_id = ? and delivery_id = ?")
    .bind(rule.user_id, rule.rule_id, deliveryId).first<RunRow>();
}

/** The trigger's facts a queued run starts with, or null when the row says enough. */
function triggerJsonOf(trigger: TriggerFacts): string | null {
  const fields = trigger.fields && Object.keys(trigger.fields).length ? trigger.fields : undefined;
  if (!trigger.body && !trigger.method && !fields) return null;
  return JSON.stringify({ body: trigger.body ?? null, method: trigger.method ?? null, ...(fields ? { fields } : {}), firedAt: trigger.firedAt });
}

/** Whether a size fits the agent limits' largest (`4x16`: up to 4 CPU and 16 GB). */
function withinShape(sizeId: CloudTierId, maxShape: string): boolean {
  const size = cloudSizeForTier(sizeId);
  const [cpu, memory] = maxShape.split("x").map(Number);
  return Boolean(size && cpu && memory && size.cpu <= cpu && size.memoryGb <= memory);
}

function dayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

const TRIGGER_WORDS: Record<CloudAutomationTrigger["kind"], string> = { schedule: "Schedule", webhook: "Webhook", manual: "Run now" };

/**
 * Makes a run's computer, as an unattended agent: the agent limits answer,
 * then the launcher's own checks (hours, computers, disk). A refusal fails
 * the run before anything is made and tells the person. ADE Cloud being
 * briefly unable to make computers (no provider, a 503) leaves the run
 * `starting` for the cron to try again, for up to `START_GIVE_UP_MS`.
 */
async function startRunLaunch(env: RelayEnv, rule: RuleRow, run: RunRow, deps: AutomationDeps): Promise<void> {
  const { now } = deps;
  const spec = specOf(rule);
  if (!spec) return failRun(env, { rule }, run.run_id, "ADE Cloud can't read this rule. Change it and save it on one of your computers.", now);
  const limits = limitsOf(rule);
  if (!limits) {
    return failRun(env, { rule }, run.run_id, "ADE Cloud couldn't read your agent limits, so it didn't start an unattended run. It reads them again the next time ADE opens this project on one of your computers.", now, { email: true });
  }
  if (!limits.unattendedSpend) {
    return failRun(env, { rule }, run.run_id, "Your agent limits say unattended agents ask before anything that uses hours, so ADE Cloud didn't start this run. Change it in Settings › ADE Cloud.", now, { email: true });
  }
  if (!withinShape(spec.sizeId, limits.maxShape)) {
    return failRun(env, { rule }, run.run_id, `This rule's computer is bigger than your agent limits allow (${limits.maxShape.replace("x", " CPU, ")} GB). Pick a smaller size or raise the limit in Settings › ADE Cloud.`, now, { email: true });
  }
  if (rule.git_ok === 0 && rule.repo_visibility === "private") {
    return failRun(env, { rule }, run.run_id, connectGitHubSentence(spec.project.origin), now, { email: true });
  }
  // The day's computers, claimed in one conditional write (`started_at` is the claim): two runs of
  // the account at once can't both take the last one. A start tried again keeps the claim it made,
  // across midnight too: it counts on the day it first claimed. Claiming again there could fail a
  // run whose computer the provider already made (its answer lost), before the launch finds it.
  if (run.started_at == null) {
    const today = dayStart(now);
    const claimed = await env.DB.prepare(`
      update cloud_automation_runs set started_at = ?, updated_at = ? where run_id = ? and state = 'starting' and started_at is null
        and (select count(*) from cloud_automation_runs where user_id = ? and started_at >= ? and run_id <> ?) < ?
    `).bind(now, now, run.run_id, rule.user_id, today, run.run_id, limits.machinesPerDay).run();
    if ((claimed.meta?.changes ?? 0) !== 1) {
      const latest = await readRun(env, run.run_id);
      // Another tick claimed it (or the run moved on): that one goes on with it.
      if (!latest || latest.state !== "starting" || latest.started_at != null) return;
      return failRun(env, { rule }, run.run_id, `Your agent limits allow ${limits.machinesPerDay} new computer${limits.machinesPerDay === 1 ? "" : "s"} a day for unattended agents, and today's are used. Raise the limit in Settings › ADE Cloud.`, now, { email: true });
    }
  }
  const waitOrGiveUp = async (why: string): Promise<void> => {
    // A queued run's clock starts when it left the queue (`not_before`).
    if (now - (run.not_before ?? run.created_at) < START_GIVE_UP_MS) {
      // Nothing was made: the cron tries this start again.
      logCloud("cloud.automation_run_start_waiting", { runId: run.run_id, why });
      return;
    }
    await failRun(env, { rule }, run.run_id, "ADE Cloud couldn't make this run's computer for an hour, so it gave up on this run.", now, { unclaimDay: true });
  };
  if (!deps.provider) return waitOrGiveUp("no_provider");
  let trigger: TriggerFacts = { kind: run.trigger_kind, summary: run.trigger_summary, firedAt: run.created_at };
  if (run.trigger_json) {
    try {
      trigger = { ...trigger, ...(JSON.parse(run.trigger_json) as Partial<TriggerFacts>) };
    } catch (error) {
      // The run starts with what the row says.
      logCloud("cloud.automation_trigger_unreadable", { runId: run.run_id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  const laneId = run.lane_id ?? crypto.randomUUID();
  const request: CloudServerLaunchRequest = {
    launchId: run.run_id,
    kind: "chat",
    sizeId: spec.sizeId,
    project: { origin: spec.project.origin },
    lane: { id: laneId, name: spec.name.slice(0, 120), ...(spec.lane?.from ? { from: spec.lane.from } : {}) },
    chat: {
      provider: spec.chat.provider,
      modelId: spec.chat.modelId,
      ...(spec.chat.effort ? { effort: spec.chat.effort } : {}),
      permissions: spec.chat.permissions,
      ...(spec.chat.fast ? { fast: true } : {}),
      prompt: runPrompt(spec, trigger, now),
    },
    madeBy: { kind: "automation", ruleId: rule.rule_id },
    // The registering ADE's track: a Beta ADE's rule runs on the Beta image, which knows the join.
    channel: spec.channel === "beta" ? "beta" : "stable",
  };
  // The lane id first: a start the Worker loses is tried again with the same lane.
  await env.DB.prepare("update cloud_automation_runs set lane_id = ?, updated_at = ? where run_id = ?").bind(laneId, now, run.run_id).run();
  const response = await startServerLaunch(env, rule.user_id, request, { provider: deps.provider, now, createComputer: deps.createComputer });
  if (response.status === 201 || response.status === 200) {
    const record = await response.json() as CloudLaunchRecord;
    await env.DB.prepare(`
      update cloud_automation_runs set state = 'running', instance_id = ?, started_at = coalesce(started_at, ?), updated_at = ? where run_id = ? and state = 'starting'
    `).bind(record.instanceId, now, now, run.run_id).run();
    logCloud("cloud.automation_run_started", { userId: rule.user_id, ruleId: rule.rule_id, runId: run.run_id });
    await noteAutomationLaunchProgress(env, record, deps);
    return;
  }
  if (response.status === 409) return; // A create still in flight: the cron's retry finds it.
  if (response.status === 503) {
    // ADE Cloud can't make computers right now (no provider, no capacity): not this run's fault.
    await response.body?.cancel().catch(() => {});
    return waitOrGiveUp("unavailable");
  }
  const refusal = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
  const message = typeof refusal?.error?.message === "string" ? refusal.error.message : "ADE Cloud couldn't make this run's computer.";
  // Refused before anything was made: the day's computer it claimed is free again.
  await failRun(env, { rule }, run.run_id, message, now, { email: true, unclaimDay: true });
}

/**
 * One trigger of a rule: a run now, a run waiting for the one before it, or a
 * skipped one, and never more than one of each. The rows are claimed in
 * single conditional writes, so two triggers at once can't both start.
 * `notBefore` (a delivery during a handover) only queues: the run waits
 * until then, and the cron starts it.
 */
async function triggerRun(env: RelayEnv, rule: RuleRow, trigger: TriggerFacts, deps: AutomationDeps, options: { notBefore?: number } = {}): Promise<RunRow> {
  const { now } = deps;
  const runId = crypto.randomUUID();
  if (trigger.deliveryId) {
    const seen = await readDelivery(env, rule, trigger.deliveryId);
    if (seen) return seen;
  }
  const notBefore = options.notBefore != null && options.notBefore > now ? options.notBefore : null;
  const insert = (state: CloudAutomationRunState, guard: string) => env.DB.prepare(`
    insert or ignore into cloud_automation_runs (run_id, user_id, rule_id, trigger_kind, trigger_summary, trigger_json, delivery_id, state, reason, not_before, ended_at, created_at, updated_at)
    select ?, ?, ?, ?, ?, ?, ?, ?, null, ?, null, ?, ? ${guard}
  `);
  const values = (state: CloudAutomationRunState) => [
    runId, rule.user_id, rule.rule_id, trigger.kind, trigger.summary, triggerJsonOf(trigger), trigger.deliveryId ?? null, state,
    state === "queued" ? notBefore : null, now, now,
  ];
  const written = async (): Promise<RunRow> => {
    const row = await readRun(env, runId);
    if (!row) throw new Error("A run's row was not written.");
    return row;
  };
  await pruneRuns(env, rule.user_id, rule.rule_id, now);

  // The storm stop: past the rule's runs an hour, the rule pauses and the person hears once.
  const lastHour = await env.DB.prepare("select count(*) as count from cloud_automation_runs where user_id = ? and rule_id = ? and created_at > ? and state <> 'skipped'")
    .bind(rule.user_id, rule.rule_id, now - 60 * 60_000).first<{ count: number }>();
  if ((lastHour?.count ?? 0) >= rule.max_runs_per_hour) {
    const paused = await env.DB.prepare("update cloud_automations set enabled = 0, paused_reason = 'storm', paused_at = ?, updated_at = ? where user_id = ? and rule_id = ? and enabled = 1")
      .bind(now, now, rule.user_id, rule.rule_id).run();
    if ((paused.meta?.changes ?? 0) === 1) {
      logCloud("cloud.automation_storm_paused", { userId: rule.user_id, ruleId: rule.rule_id });
      await tell(env, rule, `"${rule.name}" is paused`, `It started ${rule.max_runs_per_hour} runs in an hour on ADE Cloud, so ADE paused it. Turn the rule off and on again to start it again.`, now, true);
    }
    return await recordSkipped(env, rule, trigger, `Paused: it started ${rule.max_runs_per_hour} runs in an hour.`, now);
  }

  // One at a time: this one starts only when no run of the rule is starting or running.
  if (!notBefore) {
    const started = await insert("starting", `where not exists (select 1 from cloud_automation_runs where user_id = ? and rule_id = ? and state in ${ACTIVE_STATES})`)
      .bind(...values("starting"), rule.user_id, rule.rule_id).run();
    if ((started.meta?.changes ?? 0) === 1) {
      const run = await written();
      try {
        await startRunLaunch(env, rule, run, deps);
      } catch (error) {
        // Left `starting`: the cron tries the same launch id again.
        reportCloudFailure("cloud.automation_run_start_failed", { runId, code: error instanceof CloudProviderError ? error.code : "unknown" });
      }
      return await written();
    }
  }
  // One waits, the rest are recorded as skipped.
  const queued = await insert("queued", `where not exists (select 1 from cloud_automation_runs where user_id = ? and rule_id = ? and state = 'queued')`)
    .bind(...values("queued"), rule.user_id, rule.rule_id).run();
  if ((queued.meta?.changes ?? 0) === 1) return await written();
  return await recordSkipped(env, rule, trigger, notBefore
    ? "Another delivery was already waiting for the rule to finish moving to ADE Cloud."
    : "Another run of this rule was already running, and one was waiting.", now);
}

/**
 * A launch an automation's run made moved on (the computer's report, a
 * cancel, or the start itself). The run follows: running once the computer
 * exists, finishing once the chat ended or the launch failed.
 */
export async function noteAutomationLaunchProgress(env: RelayEnv, record: CloudLaunchRecord, deps: Pick<AutomationDeps, "now">): Promise<void> {
  if (record.request?.madeBy?.kind !== "automation") return;
  const run = await readRun(env, record.launchId);
  if (!run || (run.state !== "starting" && run.state !== "running")) return;
  const { now } = deps;
  if (record.state === "cancelled") {
    return failRun(env, { run }, run.run_id, "The run's launch was cancelled, and its computer deleted.", now, { states: ACTIVE_STATES });
  }
  const runStage = record.stages.find((stage) => stage.id === CLOUD_AUTOMATION_RUN_STAGE);
  const ended = record.state === "failed" || runStage?.status === "done" || runStage?.status === "failed";
  if (ended) {
    const failed = record.state === "failed" || runStage?.status === "failed";
    const reason = failed ? (record.error ?? runStage?.error ?? "The run's chat stopped with an error.") : null;
    await env.DB.prepare(`
      update cloud_automation_runs set state = 'finishing', outcome = ?, reason = coalesce(?, reason), instance_id = coalesce(instance_id, ?),
        claimed_at = null, updated_at = ? where run_id = ? and state in ('starting', 'running')
    `).bind(failed ? "failed" : "done", reason, record.instanceId, now, run.run_id).run();
    if (failed) {
      const rule = await readRule(env, run.user_id, run.rule_id);
      if (rule && reason) await tell(env, rule, `"${rule.name}" failed on ADE Cloud`, reason, now, false);
    }
    return;
  }
  // Progress: the run's clock for `RUN_MAX_MS` restarts.
  await env.DB.prepare(`
    update cloud_automation_runs set state = 'running', instance_id = coalesce(instance_id, ?), started_at = coalesce(started_at, ?), updated_at = ?
    where run_id = ? and state in ('starting', 'running')
  `).bind(record.instanceId, now, now, run.run_id).run();
}

/**
 * After the run: its computer's chats are saved and its work pushed, then
 * the computer is deleted and its lane kept as a lane without a computer.
 * Anything short of "everything is on GitHub" keeps the computer and says why.
 */
async function finishRun(env: RelayEnv, provider: CloudProvider, run: RunRow, now: number): Promise<void> {
  const rule = await readRule(env, run.user_id, run.rule_id);
  const outcome = run.outcome === "failed" ? "failed" : "done";
  const end = async (computer: "freed" | "kept" | null, why: string | null): Promise<void> => {
    const reason = [run.reason, why].filter(Boolean).join(" ") || null;
    await env.DB.prepare(`update cloud_automation_runs set state = ?, computer = ?, reason = ?, ended_at = ?, claimed_at = null, updated_at = ? where run_id = ? and state = 'finishing'`)
      .bind(outcome, computer, reason, Date.now(), Date.now(), run.run_id).run();
    // A rule deleted meanwhile keeps no history.
    if (!rule) await env.DB.prepare("delete from cloud_automation_runs where run_id = ?").bind(run.run_id).run();
  };
  const computer = run.instance_id ? await ownedComputer(env, run.user_id, run.instance_id) : null;
  if (!computer) return end(null, null);
  if (rule?.keep_computer === 1) return end("kept", "This rule keeps its computer after a run.");
  const wake: WakeRecord = { woke: false, from: computer.status };
  const keep = async (why: string): Promise<void> => {
    if (wake.woke) await putBackToRest(env, provider, computer.instance_id, wake.from);
    return end("kept", `Its computer stays: ${why}`);
  };
  try {
    // The plan cleanup's push: stop the agents and save the chats, push every lane, check again.
    const outcome = await pushAllWork(env, provider, computer, now, wake, "automation_run");
    if (!outcome.ok) return keep(outcome.reason);
    const { metadata, pushed } = outcome;
    const lane = mergeLaneFacts(laneFactsOfRow(computer), laneFactsOf(metadata));
    const own = pushed.lanes?.find((entry) => entry.laneId === lane.laneId) ?? null;
    if (own?.branchRef) lane.branch = own.branchRef;
    const laneKept = namesLane(lane);
    if (laneKept) await markKeepLaneStatement(env, computer, lane, "freed").run();
    try {
      await deleteComputer(env, provider, computer, { who: "automation", reason: "automation_run_done" }, Date.now());
    } catch (error) {
      if (laneKept) await unmarkKeepLaneStatement(env, computer.instance_id).run();
      throw error;
    }
    logCloud("cloud.automation_run_freed", { runId: run.run_id, instanceId: computer.instance_id, keptLane: laneKept });
    return end("freed", null);
  } catch (error) {
    reportCloudFailure("cloud.automation_run_free_failed", { runId: run.run_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return keep("ADE Cloud couldn't reach it to push its work.");
  }
}

/* ---- The minute cron ---- */

type CronRow = { what: "fire" | "run"; user_id: string; rule_id: string; run_id: string | null; state: string | null; at: number | null };

/**
 * Two indexed reads a minute: runs that need the server (one
 * waiting, a start that never finished, a run gone quiet, a computer to free),
 * and rules whose schedule is due. Each read has its own page, and the runs go
 * first, so a backlog of due schedules (after an outage) can't hold back the
 * runs whose computers are waiting to be freed. Nothing at all is read beyond
 * it when both answer no rows.
 */
export async function runCloudAutomations(env: RelayEnv, deps: Omit<AutomationDeps, "now"> & { now?: number }): Promise<void> {
  const now = deps.now ?? Date.now();
  const [runRows, fireRows] = await Promise.all([
    env.DB.prepare(`
      select 'run' as what, user_id, rule_id, run_id, state, updated_at as at
        from cloud_automation_runs where state in ${OPEN_STATES}
          and ((state = 'queued' and (not_before is null or not_before <= ?)) or (state = 'starting' and updated_at < ?) or (state = 'running' and updated_at < ?)
            or (state = 'finishing' and (claimed_at is null or claimed_at < ?)))
      limit ?
    `).bind(now, now - START_STALE_MS, now - RUN_MAX_MS, now - FINISH_CLAIM_MS, CRON_ROWS).all<CronRow>(),
    env.DB.prepare(`
      select 'fire' as what, user_id, rule_id, null as run_id, null as state, next_fire_at as at
        from cloud_automations where enabled = 1 and next_fire_at is not null and next_fire_at <= ?
      limit ?
    `).bind(now, CRON_ROWS).all<CronRow>(),
  ]);
  const rows = [...(runRows.results ?? []), ...(fireRows.results ?? [])];
  if (rows.length === 0) return;
  const runDeps: AutomationDeps = { ...deps, now };
  let finishes = 0;
  for (const row of rows) {
    try {
      if (row.what === "fire") await fireSchedule(env, row, runDeps);
      else if (row.state === "finishing") {
        if (finishes >= FINISHES_PER_TICK || !deps.provider) continue;
        const claimed = await env.DB.prepare("update cloud_automation_runs set claimed_at = ? where run_id = ? and state = 'finishing' and (claimed_at is null or claimed_at < ?)")
          .bind(now, row.run_id, now - FINISH_CLAIM_MS).run();
        if ((claimed.meta?.changes ?? 0) !== 1) continue;
        finishes += 1;
        const run = row.run_id ? await readRun(env, row.run_id) : null;
        if (run) await finishRun(env, deps.provider, run, now);
      } else await moveRunOn(env, row, runDeps);
    } catch (error) {
      reportCloudFailure("cloud.automation_tick_failed", { ruleId: row.rule_id, runId: row.run_id, error: error instanceof Error ? error.message : "unknown" });
    }
  }
}

async function fireSchedule(env: RelayEnv, row: CronRow, deps: AutomationDeps): Promise<void> {
  const { now } = deps;
  const rule = await readRule(env, row.user_id, row.rule_id);
  if (!rule?.cron || !rule.timezone || rule.next_fire_at == null) return;
  // Claimed by moving the fire time on, so two ticks can't both fire it.
  const next = nextFireAt(rule.cron, rule.timezone, now);
  const claimed = await env.DB.prepare("update cloud_automations set next_fire_at = ? where user_id = ? and rule_id = ? and next_fire_at = ?")
    .bind(next, rule.user_id, rule.rule_id, rule.next_fire_at).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  if (!cloudAccessAllows(env, rule.user_id)) return;
  const due = rule.next_fire_at;
  if (due < rule.starts_at) return;
  if (now - due >= CATCH_UP_MS) {
    // Missed (the server was down, or the rule was waiting): recorded, not run late.
    await recordSkipped(env, rule, { kind: "schedule", summary: `Due ${new Date(due).toISOString()}`, firedAt: due }, "Missed: ADE Cloud didn't reach it within an hour of its time.", now);
    return;
  }
  await triggerRun(env, rule, { kind: "schedule", summary: `Due ${new Date(due).toISOString()}`, firedAt: due }, deps);
}

async function moveRunOn(env: RelayEnv, row: CronRow, deps: AutomationDeps): Promise<void> {
  const { now } = deps;
  const run = row.run_id ? await readRun(env, row.run_id) : null;
  if (!run) return;
  const rule = await readRule(env, run.user_id, run.rule_id);
  if (run.state === "queued") {
    if (!rule) {
      await env.DB.prepare("delete from cloud_automation_runs where run_id = ? and state = 'queued'").bind(run.run_id).run();
      return;
    }
    // A rule turned off (or storm-paused) since this run queued: it never starts. A Run now
    // asked for while the rule is off still runs, unless a storm paused the rule.
    if (rule.enabled !== 1 && (run.trigger_kind !== "manual" || rule.paused_reason)) {
      await env.DB.prepare(`
        update cloud_automation_runs set state = 'skipped', reason = ?, trigger_json = null, not_before = null, ended_at = ?, updated_at = ? where run_id = ? and state = 'queued'
      `).bind(rule.paused_reason === "storm" ? "The rule is paused." : "The rule is off.", now, now, run.run_id).run();
      logCloud("cloud.automation_queued_run_dropped", { userId: run.user_id, ruleId: run.rule_id, runId: run.run_id });
      return;
    }
    // The waiting run starts once nothing of its rule is starting or running.
    const claimed = await env.DB.prepare(`
      update cloud_automation_runs set state = 'starting', not_before = ?, updated_at = ? where run_id = ? and state = 'queued'
        and (not_before is null or not_before <= ?)
        and not exists (select 1 from cloud_automation_runs where user_id = ? and rule_id = ? and state in ${ACTIVE_STATES})
    `).bind(now, now, run.run_id, now, run.user_id, run.rule_id).run();
    if ((claimed.meta?.changes ?? 0) === 1) await startRunLaunch(env, rule, { ...run, state: "starting", not_before: now }, deps);
    return;
  }
  if (run.state === "starting") {
    if (!rule) return failRun(env, { run }, run.run_id, "Its rule was deleted.", now);
    // The same launch id: a computer an earlier attempt made is found, not made twice.
    await env.DB.prepare("update cloud_automation_runs set updated_at = ? where run_id = ? and state = 'starting'").bind(now, run.run_id).run();
    return await startRunLaunch(env, rule, run, deps);
  }
  if (run.state === "running") {
    // Quiet for `RUN_MAX_MS`: stopped, its work pushed and its lane kept.
    await env.DB.prepare(`
      update cloud_automation_runs set state = 'finishing', outcome = 'failed', reason = ?, claimed_at = null, updated_at = ? where run_id = ? and state = 'running' and updated_at < ?
    `).bind(`Stopped: its computer didn't report for ${RUN_MAX_MS / 3_600_000} hours.`, now, run.run_id, now - RUN_MAX_MS).run();
  }
}

/* ---- The relay's forward: no account token, the hook's signature ---- */

/** `POST /cloud/automations/:ruleId/deliveries/:userId`: answered before the account check, like a launch's join. */
export function isAutomationDeliveryRequest(path: string, method: string): boolean {
  if (method !== "POST" || !path.startsWith(`${CLOUD_PATHS.automations}/`)) return false;
  const [ruleId, action, userId, ...rest] = path.slice(CLOUD_PATHS.automations.length + 1).split("/");
  return Boolean(ruleId) && action === "deliveries" && Boolean(userId) && rest.length === 0;
}

/**
 * A custom webhook's delivery, forwarded by the webhook relay. Checked before
 * anything is read for it: the hook's own signature over the timestamp and
 * the body, and a timestamp within minutes. 2xx tells the relay to forget the
 * delivery; 410 tells it the hook no longer forwards here (the relay keeps it
 * for the rule's computer). A repeat of a delivery answers the same run.
 */
export async function handleAutomationDelivery(request: Request, env: RelayEnv, path: string, deps: AutomationDeps): Promise<Response> {
  const refused = () => fail("signature_refused", "This delivery isn't signed for this automation.", 401);
  const segments = path.slice(CLOUD_PATHS.automations.length + 1).split("/");
  const ruleId = decodedSegment(segments[0] ?? "");
  const userId = decodedSegment(segments[2] ?? "");
  const hookId = request.headers.get(CLOUD_AUTOMATION_HOOK_HEADERS.hookId)?.trim() ?? "";
  const timestamp = Number(request.headers.get(CLOUD_AUTOMATION_HOOK_HEADERS.timestamp) ?? NaN);
  const signature = request.headers.get(CLOUD_AUTOMATION_HOOK_HEADERS.signature)?.trim().toLowerCase() ?? "";
  if (!ruleId || !RULE_ID.test(ruleId) || !userId || userId.length > 200 || !HOOK_ID.test(hookId) || !/^[0-9a-f]{64}$/.test(signature) || !Number.isFinite(timestamp)) return refused();
  const text = await request.text();
  if (text.length > 2_000_000) return fail("payload_too_large", "That delivery is too large.", 413);
  // The owner's one row (the path names the owner), for this hook. The signature,
  // whose key is derived with the owner's id, proves the delivery is for it.
  const row = await env.DB.prepare("select * from cloud_automations where user_id = ? and rule_id = ?").bind(userId, ruleId).first<RuleRow>();
  if (!row || row.hook_id !== hookId) return fail("gone", "This webhook doesn't run on ADE Cloud any more.", 410);
  const key = await hookKey(env, row);
  if (!key) return fail("unavailable", "ADE Cloud can't check deliveries right now.", 503);
  const rule: RuleRow | null = sameText(await hmacHex(key, `${timestamp}.${text}`), signature) ? row : null;
  if (!rule) {
    logCloud("cloud.automation_delivery_refused", { ruleId });
    return refused();
  }
  const { now } = deps;
  if (Math.abs(now - timestamp) > HOOK_MAX_SKEW_MS) return fail("stale_signature", "This delivery's signature is too old. Send it again.", 401);
  if (!cloudAccessAllows(env, rule.user_id)) return fail("gone", "This webhook doesn't run on ADE Cloud any more.", 410);
  let delivery: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    delivery = parsed as Record<string, unknown>;
  } catch {
    return badRequest(UNREADABLE_REQUEST_MESSAGE);
  }
  const deliveryId = typeof delivery.eventId === "string" && UUID.test(delivery.eventId) ? delivery.eventId : null;
  if (!deliveryId) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const receivedAt = typeof delivery.receivedAt === "string" ? Date.parse(delivery.receivedAt) : now;
  const method = typeof delivery.method === "string" ? delivery.method.slice(0, 10).toUpperCase() : "POST";
  const binary = delivery.bodyEncoding === "base64";
  const fullBody = typeof delivery.body === "string" && !binary ? delivery.body : "";
  const body = binary ? "(a binary body)" : fullBody.slice(0, MAX_TRIGGER_BODY_CHARS);
  const spec = specOf(rule);
  const webhook = spec?.triggers.find((trigger): trigger is Extract<CloudAutomationTrigger, { kind: "webhook" }> => trigger.kind === "webhook");
  const facts: TriggerFacts = {
    kind: "webhook",
    summary: `${method} delivery`,
    body,
    method,
    fields: spec ? bodyFieldsFor(spec.chat.prompt, fullBody) : {},
    firedAt: Number.isFinite(receivedAt) ? receivedAt : now,
    deliveryId,
  };
  const answer = (run: RunRow) => json({ runId: run.run_id, state: run.state }, 202);
  if (rule.enabled !== 1 || !webhook) {
    return answer(await recordSkipped(env, rule, facts, rule.paused_reason === "storm" ? "The rule is paused." : "The rule is off.", now));
  }
  if (webhook.maxAgeMinutes && now - facts.firedAt > webhook.maxAgeMinutes * 60_000) {
    return answer(await recordSkipped(env, rule, facts, `The relay held it longer than the rule's ${webhook.maxAgeMinutes} minutes.`, now));
  }
  // While the rule is still moving here from a computer, the delivery waits for the handover's end.
  return answer(await triggerRun(env, rule, facts, deps, rule.starts_at > now ? { notBefore: rule.starts_at } : {}));
}

/** A path segment decoded, or null when it isn't valid percent-encoding. */
function decodedSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/* ---- The account-token routes ---- */

export async function routeAutomations(request: Request, url: URL, path: string, env: RelayEnv, userId: string, deps: AutomationDeps): Promise<Response> {
  if (path === CLOUD_PATHS.automations) {
    if (request.method !== "GET") return notFound();
    const origin = githubOriginOf(url.searchParams.get("origin"));
    const rules = (await env.DB.prepare(`select * from cloud_automations where user_id = ?${origin ? " and project_origin = ?" : ""} order by name limit ?`)
      .bind(...(origin ? [userId, origin] : [userId]), MAX_RULES_PER_ACCOUNT).all<RuleRow>()).results ?? [];
    if (rules.length === 0) return json({ automations: [] });
    const runs = (await env.DB.prepare(`
      select * from (select r.*, row_number() over (partition by rule_id order by created_at desc) as position
        from cloud_automation_runs r where user_id = ? and rule_id in (select value from json_each(?)))
      where position <= ? order by created_at desc
    `).bind(userId, JSON.stringify(rules.map((rule) => rule.rule_id)), RUNS_LISTED).all<RunRow>()).results ?? [];
    return json({ automations: rules.map((rule) => summaryOf(rule, runs.filter((run) => run.rule_id === rule.rule_id))) });
  }
  const [rawId = "", action, ...rest] = path.slice(CLOUD_PATHS.automations.length + 1).split("/");
  const ruleId = decodedSegment(rawId);
  if (!ruleId || !RULE_ID.test(ruleId) || rest.length) return notFound();
  if (action === undefined) {
    if (request.method === "PUT") return await handleRegister(request, env, userId, ruleId, deps.now);
    if (request.method === "DELETE") {
      // `through`: a brain releasing what it saw (a rule deleted, or homed on a computer) never takes a newer save with it.
      const through = shortString(url.searchParams.get("through"), 64);
      const deleted = await env.DB.prepare(`delete from cloud_automations where user_id = ? and rule_id = ?${through ? " and rule_version <= ?" : ""}`)
        .bind(...(through ? [userId, ruleId, through] : [userId, ruleId])).run();
      if (through && (deleted.meta?.changes ?? 0) === 0 && await readRule(env, userId, ruleId)) {
        logCloud("cloud.automation_unregister_newer_kept", { userId, ruleId });
        return json({ deleted: false, kept: true });
      }
      // Ended runs go with it; a run still going ends on its own and then goes too.
      await env.DB.prepare(`delete from cloud_automation_runs where user_id = ? and rule_id = ? and state not in ${OPEN_STATES}`).bind(userId, ruleId).run();
      // A run that hasn't started yet never will.
      await env.DB.prepare("delete from cloud_automation_runs where user_id = ? and rule_id = ? and state = 'queued'").bind(userId, ruleId).run();
      logCloud("cloud.automation_unregistered", { userId, ruleId });
      return json({ deleted: (deleted.meta?.changes ?? 0) > 0 });
    }
    if (request.method === "GET") {
      const rule = await readRule(env, userId, ruleId);
      if (!rule) return notFound();
      const runs = (await env.DB.prepare("select * from cloud_automation_runs where user_id = ? and rule_id = ? order by created_at desc limit ?")
        .bind(userId, ruleId, RUNS_LISTED).all<RunRow>()).results ?? [];
      return json(summaryOf(rule, runs));
    }
    return notFound();
  }
  const rule = await readRule(env, userId, ruleId);
  if (!rule) return notFound();
  if (action === "runs" && request.method === "GET") {
    const runs = (await env.DB.prepare("select * from cloud_automation_runs where user_id = ? and rule_id = ? order by created_at desc limit ?")
      .bind(userId, ruleId, RUNS_LISTED).all<RunRow>()).results ?? [];
    return json({ runs: runs.map(runOf) });
  }
  if (action === "run" && request.method === "POST") {
    const run = await triggerRun(env, rule, { kind: "manual", summary: TRIGGER_WORDS.manual, firedAt: deps.now }, deps);
    return json(runOf(run), run.state === "failed" ? 200 : 202);
  }
  return notFound();
}

/** Every rule and run of one account, for an account deletion. */
export async function deleteAccountAutomations(env: Pick<RelayEnv, "DB">, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("delete from cloud_automation_runs where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_automations where user_id = ?").bind(userId),
  ]);
}

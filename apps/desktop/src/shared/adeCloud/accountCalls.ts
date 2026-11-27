/**
 * Account calls of ADE with no computer: the account data each surface reads
 * from the ADE account server (never from a computer, and never with a
 * wake). The desktop main process and the web client run the same mapping
 * with their own `CloudApiClient`, so both clients send the same requests.
 *
 * - Every call is in a fixed list, and each argument is checked here. On
 *   the desktop, main runs this with input from the renderer.
 * - The answer is the server's result, or its refusal as data (code and the
 *   server's sentence): a surface shows the sentence, and it tells an older
 *   server (null result) from a failure.
 * - No call returns a secret value: `accountSecrets` lists names only.
 */

import { CloudApiError, type CloudApiClient } from "../cloudApiClient";
import {
  CLOUD_ACCOUNT_SECRET_KINDS,
  CLOUD_LINEAR_OPS,
  type AccountLaneIndexRow,
  type CloudAccountSecretKind,
  type CloudAccountSecrets,
  type CloudAccountSignInsWithCarried,
  type CloudAccountState,
  type CloudAgentLimitsState,
  type CloudAgentLimitsUpdate,
  type CloudAgentLimitsValue,
  type CloudAutomationRun,
  type CloudAutomationSummary,
  type CloudCtoCopySummary,
  type CloudJiraIssueResult,
  type CloudJiraSearchResult,
  type CloudLinearOp,
  type CloudLinearQueryResult,
  type CloudSessionCopy,
} from "../../../../account-directory/src/cloud/contract";
import { BRAND } from "../brand";

export type AdeCloudAccountCall =
  | { call: "account" }
  | { call: "signIns" }
  | { call: "automations"; origin?: string | null }
  | { call: "automationRuns"; ruleId: string }
  | { call: "cto"; origin: string }
  | { call: "limits" }
  | { call: "saveLimits"; update: CloudAgentLimitsUpdate }
  | { call: "accountSecrets"; kind?: CloudAccountSecretKind | null; origin?: string | null }
  | { call: "accountLanes"; project?: string | null; pr?: number | null }
  | { call: "savedSession"; machineKey: string; sessionId: string }
  | { call: "linearQuery"; origin: string; op: CloudLinearOp; vars?: Record<string, unknown> }
  | { call: "jiraSearch"; origin: string; jql: string; fields?: string[]; maxResults?: number; nextPageToken?: string | null }
  | { call: "jiraIssue"; origin: string; key: string };

/** What each call answers. Null: an older server without the route (keep today's behavior). */
export type AdeCloudAccountResults = {
  account: CloudAccountState;
  signIns: CloudAccountSignInsWithCarried;
  automations: CloudAutomationSummary[];
  automationRuns: CloudAutomationRun[];
  cto: CloudCtoCopySummary | null;
  limits: CloudAgentLimitsState | null;
  saveLimits: CloudAgentLimitsState | null;
  accountSecrets: CloudAccountSecrets | null;
  accountLanes: { lanes: AccountLaneIndexRow[] } | null;
  savedSession: CloudSessionCopy | null;
  linearQuery: CloudLinearQueryResult | null;
  jiraSearch: CloudJiraSearchResult | null;
  jiraIssue: CloudJiraIssueResult | null;
};

export type AdeCloudAccountCallName = AdeCloudAccountCall["call"];

/** The server's result, or its refusal: a surface always shows `message`. */
export type AdeCloudAccountAnswer<T> =
  | { ok: true; result: T }
  | { ok: false; code: string; status: number; message: string };

/**
 * What the web shows for Passwords: only the account's key opens a password,
 * and a browser never gets it (the push relay refuses every passwords route
 * to a browser). Agents on every computer, ADE Cloud too, still use them.
 */
export const WEB_PASSWORDS_SENTENCE =
  `Open ${BRAND.NAME} desktop or the iPhone to see and change Passwords. Agents on every computer, ${BRAND.CLOUD_NAME} too, still use them.`;

/** The sentence for a request that never reached the account server. */
export const ADE_CLOUD_ACCOUNT_UNREACHABLE = `${BRAND.NAME} couldn't reach your ${BRAND.NAME} account. Try again.`;
export const ADE_CLOUD_ACCOUNT_SIGNED_OUT = `Sign in to ${BRAND.NAME} to see this with no computer on.`;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ORIGIN_MAX = 500;
const JQL_MAX = 4_000;
const VARS_MAX_BYTES = 16 * 1024;
const LIMIT_SHAPES = new Set<CloudAgentLimitsValue["maxShape"]>(["2x4", "4x8", "4x16", "4x32"]);

class InvalidCall extends Error {}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function required(value: unknown, max: number, what: string): string {
  const parsed = text(value, max);
  if (!parsed) throw new InvalidCall(`${BRAND.NAME} couldn't read the ${what} for this request.`);
  return parsed;
}

function id(value: unknown, what: string): string {
  const parsed = text(value, 128);
  if (!parsed || !ID.test(parsed)) throw new InvalidCall(`${BRAND.NAME} couldn't read the ${what} for this request.`);
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * An older app's `extraDiskMonthCents` (paid extra disk, no longer sold): whole
 * cents from 0 to $1,000, or null. Kept as saved so a whole-value save doesn't drop it.
 */
export function cloudAgentExtraDiskCentsOf(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 100_000 ? raw : null;
}

function limitsUpdate(value: unknown): CloudAgentLimitsUpdate {
  const given = record(value);
  const limits = record(given.limits);
  const out: Partial<CloudAgentLimitsValue> = {};
  if (typeof limits.unattendedSpend === "boolean") out.unattendedSpend = limits.unattendedSpend;
  if (typeof limits.machinesPerDay === "number" && Number.isInteger(limits.machinesPerDay) && limits.machinesPerDay >= 0 && limits.machinesPerDay <= 1_000) {
    out.machinesPerDay = limits.machinesPerDay;
  }
  if (typeof limits.maxShape === "string" && LIMIT_SHAPES.has(limits.maxShape as CloudAgentLimitsValue["maxShape"])) {
    out.maxShape = limits.maxShape as CloudAgentLimitsValue["maxShape"];
  }
  const extraDiskMonthCents = cloudAgentExtraDiskCentsOf(limits.extraDiskMonthCents);
  if (limits.extraDiskMonthCents === null || extraDiskMonthCents != null) out.extraDiskMonthCents = extraDiskMonthCents;
  if (Object.keys(out).length === 0) throw new InvalidCall(`${BRAND.NAME} couldn't read the limits to save.`);
  const ifRevision = given.ifRevision === null ? null : text(given.ifRevision, 200);
  return { limits: out, ...(given.ifRevision !== undefined ? { ifRevision } : {}) };
}

function linearVars(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  const vars = record(value);
  let size = 0;
  try {
    size = JSON.stringify(vars).length;
  } catch {
    throw new InvalidCall(`${BRAND.NAME} couldn't read this Linear request.`);
  }
  if (size > VARS_MAX_BYTES) throw new InvalidCall("This Linear request is too large.");
  return vars;
}

/** Runs one account call. Never throws: a failure comes back as data with a sentence. */
export async function runAdeCloudAccountCall(
  api: CloudApiClient | null,
  given: unknown,
): Promise<AdeCloudAccountAnswer<unknown>> {
  if (!api) return { ok: false, code: "signed_out", status: 401, message: ADE_CLOUD_ACCOUNT_SIGNED_OUT };
  const call = record(given);
  try {
    return { ok: true, result: await dispatch(api, call) };
  } catch (error) {
    if (error instanceof InvalidCall) return { ok: false, code: "invalid", status: 400, message: error.message };
    if (error instanceof CloudApiError) {
      return { ok: false, code: error.code || "unavailable", status: error.status, message: error.message || ADE_CLOUD_ACCOUNT_UNREACHABLE };
    }
    return { ok: false, code: "network", status: 0, message: ADE_CLOUD_ACCOUNT_UNREACHABLE };
  }
}

async function dispatch(api: CloudApiClient, call: Record<string, unknown>): Promise<unknown> {
  switch (call.call) {
    case "account":
      return await api.account();
    case "signIns":
      return await api.accountSignIns();
    case "automations":
      return await api.listAutomations(text(call.origin, ORIGIN_MAX));
    case "automationRuns":
      return await api.automationRuns(id(call.ruleId, "automation"));
    case "cto":
      return await api.ctoCopy(required(call.origin, ORIGIN_MAX, "repository"));
    case "limits":
      return await api.agentLimits();
    case "saveLimits":
      return await api.saveAgentLimits(limitsUpdate(call.update));
    case "accountSecrets": {
      const kind = typeof call.kind === "string" && (CLOUD_ACCOUNT_SECRET_KINDS as readonly string[]).includes(call.kind)
        ? call.kind as CloudAccountSecretKind
        : undefined;
      if (call.kind != null && !kind) throw new InvalidCall(`${BRAND.NAME} can't list that kind of secret.`);
      return await api.accountSecrets({ ...(kind ? { kind } : {}), origin: text(call.origin, ORIGIN_MAX) });
    }
    case "accountLanes": {
      const pr = typeof call.pr === "number" && Number.isInteger(call.pr) && call.pr > 0 ? call.pr : null;
      return await api.accountLanes({ project: text(call.project, ORIGIN_MAX), pr });
    }
    case "savedSession":
      return await api.savedSession(id(call.machineKey, "computer"), id(call.sessionId, "session"));
    case "linearQuery": {
      const op = typeof call.op === "string" && (CLOUD_LINEAR_OPS as readonly string[]).includes(call.op) ? call.op as CloudLinearOp : null;
      if (!op) throw new InvalidCall(`${BRAND.NAME} can't run that Linear request.`);
      const vars = linearVars(call.vars);
      return await api.linearQuery({ origin: required(call.origin, ORIGIN_MAX, "repository"), op, ...(vars ? { vars } : {}) });
    }
    case "jiraSearch": {
      const fields = Array.isArray(call.fields)
        ? call.fields.filter((field): field is string => typeof field === "string" && field.length <= 100).slice(0, 50)
        : undefined;
      const maxResults = typeof call.maxResults === "number" && Number.isInteger(call.maxResults)
        ? Math.min(100, Math.max(1, call.maxResults))
        : undefined;
      return await api.jiraSearch({
        origin: required(call.origin, ORIGIN_MAX, "repository"),
        jql: required(call.jql, JQL_MAX, "Jira search"),
        ...(fields ? { fields } : {}),
        ...(maxResults ? { maxResults } : {}),
        nextPageToken: text(call.nextPageToken, 2_000),
      });
    }
    case "jiraIssue":
      return await api.jiraIssue({ origin: required(call.origin, ORIGIN_MAX, "repository"), key: id(call.key, "Jira issue") });
    default:
      throw new InvalidCall(`${BRAND.NAME} doesn't know this account request.`);
  }
}

/** The bridge's typed form: what a surface calls through `window.ade.adeCloud.accountCall`. */
export type AdeCloudAccountCallFn = <C extends AdeCloudAccountCall>(
  call: C,
) => Promise<AdeCloudAccountAnswer<AdeCloudAccountResults[C["call"]]>>;

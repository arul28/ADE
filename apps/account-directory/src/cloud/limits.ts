import type { CloudAgentLimitsState, CloudAgentLimitsValue } from "./contract";
import {
  AGENT_LIMITS_KEY,
  DEFAULT_AGENT_LIMITS,
  extraDiskCentsOf,
  limitsOf,
  readVaultItem,
  readVaultScope,
  relayFetch,
  writeVaultItem,
  type RelayEnv,
  type VaultRecord,
} from "./accountVault";
import { UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { logCloud } from "./store";

/**
 * The account's agent limits for a client with no computer
 * (`GET/PUT /cloud/limits`): what an unattended agent may spend. The value
 * is the vault item every computer already reads (scope `all`, kind
 * `integration`, key `cloud-budget`, `{v: 3, agents}`; the desktop's
 * `cloudSleep.ts`), read and written with the caller's own bearer.
 *
 * A write is read-modify-write: it starts from the stored value, keeps every
 * field this server does not know (a newer ADE's), changes only the fields
 * the caller sent, and names the revision it replaces, so a change another
 * device made in between is refused as `limits_changed` instead of lost.
 */

const SCOPE = "all";
const KIND = "integration";
/** The writer the relay records for these writes. */
const WRITER = "ade-directory-web";
const SHAPES = new Set(["2x4", "4x8", "4x16", "4x32"]);
/** The old full read's page cap, for a relay without the narrow item read. */
const LEGACY_PAGES = 4;

const unavailable = () => fail("unavailable", "Daex can't reach your account's agent limits right now. Try again soon.", 503);

/** The stored item, `null` when none is stored, or `undefined` when the vault didn't answer. */
async function readStored(env: RelayEnv, authorization: string): Promise<VaultRecord | null | undefined> {
  const ref = { scope: SCOPE, kind: KIND, key: AGENT_LIMITS_KEY };
  const read = await readVaultItem(env, authorization, ref);
  if (read.ok) return read.value;
  if (read.reason === "failed") return undefined;
  const rows = await readVaultScope(env, authorization, SCOPE, LEGACY_PAGES, { partial: true });
  if (!rows) return undefined;
  return rows.find((row) => row.kind === KIND && row.key === AGENT_LIMITS_KEY && !row.deleted) ?? null;
}

function stateOf(stored: VaultRecord | null): CloudAgentLimitsState | null {
  if (!stored) return { limits: valueOf(DEFAULT_AGENT_LIMITS), revision: null, stored: false };
  const parsed = limitsOf(stored.value);
  // Stored but unreadable (a newer ADE's format): never shown as the defaults.
  if (!parsed) return null;
  return { limits: valueOf(parsed), revision: stored.updatedAt || null, stored: true };
}

function valueOf(limits: typeof DEFAULT_AGENT_LIMITS): CloudAgentLimitsValue {
  return {
    unattendedSpend: limits.unattendedSpend,
    machinesPerDay: limits.machinesPerDay,
    maxShape: (SHAPES.has(limits.maxShape) ? limits.maxShape : DEFAULT_AGENT_LIMITS.maxShape) as CloudAgentLimitsValue["maxShape"],
    extraDiskMonthCents: extraDiskCentsOf(limits.extraDiskMonthCents),
  };
}

/** The fields a write changes, or a sentence saying which one is wrong. */
function changesOf(raw: unknown): Partial<CloudAgentLimitsValue> | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Send the limits to change.";
  const input = raw as Record<string, unknown>;
  const out: Partial<CloudAgentLimitsValue> = {};
  if ("unattendedSpend" in input) {
    if (typeof input.unattendedSpend !== "boolean") return "unattendedSpend must be true or false.";
    out.unattendedSpend = input.unattendedSpend;
  }
  if ("machinesPerDay" in input) {
    const value = input.machinesPerDay;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) return "machinesPerDay must be a whole number from 0 to 100.";
    out.machinesPerDay = value;
  }
  if ("maxShape" in input) {
    if (typeof input.maxShape !== "string" || !SHAPES.has(input.maxShape)) return "maxShape must be one of Daex Cloud's sizes.";
    out.maxShape = input.maxShape as CloudAgentLimitsValue["maxShape"];
  }
  if ("extraDiskMonthCents" in input) {
    const value = input.extraDiskMonthCents;
    if (value !== null && extraDiskCentsOf(value) === null) return "extraDiskMonthCents must be null or whole cents from 0 to 100000.";
    out.extraDiskMonthCents = value === null ? null : extraDiskCentsOf(value);
  }
  return Object.keys(out).length ? out : "Send at least one limit to change.";
}

/** The stored JSON with `changes` applied to its `agents`, every other field kept. */
function mergedValue(stored: VaultRecord | null, changes: Partial<CloudAgentLimitsValue>): string {
  let base: Record<string, unknown> = {};
  if (stored?.value) {
    try {
      const parsed = JSON.parse(stored.value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const agents = base.agents && typeof base.agents === "object" && !Array.isArray(base.agents) ? base.agents as Record<string, unknown> : {};
  // A value with no `agents` yet starts from the defaults, as every computer reads it.
  const start = stored ? agents : { ...valueOf(DEFAULT_AGENT_LIMITS) };
  return JSON.stringify({ ...base, v: 3, agents: { ...start, ...changes } });
}

/** `/cloud/limits`. */
export async function routeCloudLimits(request: Request, env: RelayEnv): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (!authorization) return fail("unauthorized", "Sign in to Daex to use Daex Cloud.", 401);
  if (!relayFetch(env)) return unavailable();
  if (request.method === "GET") {
    const stored = await readStored(env, authorization);
    if (stored === undefined) return unavailable();
    const state = stateOf(stored);
    if (!state) return fail("limits_unreadable", "Your agent limits were saved by a newer Daex. Update Daex to see or change them.", 409);
    return json(state);
  }
  if (request.method !== "PUT") return fail("not_found", "Daex Cloud has no such route.", 404);

  const body = await readJson(request);
  if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  const changes = changesOf(body.limits);
  if (typeof changes === "string") return fail("bad_request", changes, 400);
  const named = body.ifRevision;
  if (named !== undefined && named !== null && typeof named !== "string") return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);

  const stored = await readStored(env, authorization);
  if (stored === undefined) return unavailable();
  const current = stored?.updatedAt || null;
  // `ifRevision` left out: the caller accepts whatever is stored now (an old client).
  if (named !== undefined && (named ?? null) !== current) {
    return fail("limits_changed", "Your agent limits changed on another device. Look at them again, then save.", 409, { state: stateOf(stored) });
  }
  if (stored && !limitsOf(stored.value)) {
    return fail("limits_unreadable", "Your agent limits were saved by a newer Daex. Update Daex to see or change them.", 409);
  }
  const written = await writeVaultItem(env, authorization, {
    scope: SCOPE,
    kind: KIND,
    key: AGENT_LIMITS_KEY,
    value: mergedValue(stored, changes),
    ifRevision: current ?? "absent",
  }, WRITER);
  if (written === "stale") {
    return fail("limits_changed", "Your agent limits changed on another device. Look at them again, then save.", 409);
  }
  if (written === "failed") return unavailable();
  logCloud("cloud.limits_saved", { fields: Object.keys(changes).sort().join(",") });
  const after = await readStored(env, authorization);
  const state = after === undefined ? null : stateOf(after);
  return state ? json(state) : unavailable();
}

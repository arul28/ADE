/**
 * NoMac as DAEX Cloud's Macs see it: the ids and labels that tie a NoMac
 * session or drive to a `cloud_computers` row, and the session API every Mac
 * part reads (`macProvider.ts`, `macDrives.ts`). Nothing here writes a row.
 */

import type { CloudMacStartFailure, CloudMacStateName } from "./contract";
import { nomac, type NomacAnswer } from "./phoneNomac";
import type { CloudEnv } from "./store";

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
export function macLabelPrefix(env: Pick<CloudEnv, "MAC_LABEL_PREFIX">): string {
  const prefix = env.MAC_LABEL_PREFIX?.trim() ?? "";
  return MAC_LABEL_PREFIX_SHAPE.test(prefix) ? prefix : MAC_LABEL_PREFIX_DEFAULT;
}

/* ---- Ids and labels ---- */

export const looksLikeMacId = (id: string): boolean => MAC_ID.test(id);
export const macLabelOf = (env: Pick<CloudEnv, "MAC_LABEL_PREFIX">, instanceId: string): string => `${macLabelPrefix(env)}${instanceId}`;
/** The Mac a label of this environment names; null for any other label (another environment's included). */
export function instanceIdOfMacLabel(env: Pick<CloudEnv, "MAC_LABEL_PREFIX">, label: unknown): string | null {
  const prefix = macLabelPrefix(env);
  return typeof label === "string" && label.startsWith(prefix) && MAC_ID.test(label.slice(prefix.length)) ? label.slice(prefix.length) : null;
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

export const isoMs = (value: unknown): number | null => {
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

export async function macCall(env: CloudEnv, method: string, path: string, body?: unknown, idempotencyKey?: string, timeoutMs?: number): Promise<NomacAnswer> {
  // A timeout or a dropped connection: unknown, like a 5xx (callers treat 5xx as "may have happened").
  return nomac(env, method, `/api/v1${path}`, body, idempotencyKey, timeoutMs).catch((): NomacAnswer => ({ status: 504, body: null }));
}

/** What a call that asks NoMac to hold (`?wait=N`) may take: the wait and room for the answer. */
export const waitTimeoutMs = (waitSeconds: number): number => (waitSeconds + 10) * 1000;

export async function readSession(env: CloudEnv, sessionId: string, timeoutMs?: number): Promise<MacSession | null | "unreadable"> {
  const answer = await macCall(env, "GET", `/mac/sessions/${encodeURIComponent(sessionId)}`, undefined, undefined, timeoutMs);
  if (answer.status === 404) return null;
  const session = macSessionOf(answer.body?.session);
  return answer.status === 200 && session ? session : "unreadable";
}

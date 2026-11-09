/**
 * The ADE Cloud routes this Worker serves, as a client mirrors them. Paths and
 * response shapes only: nothing here imports the Worker, so the desktop can
 * copy it.
 *
 * Every route takes the account token as a bearer. A caller not on the access
 * list gets 404 `not_found` from everything except `GET /cloud/access`. Errors
 * are `{ error: { code, message } }` and `message` is one plain sentence.
 *
 *   GET    /cloud/access                       { enabled }
 *   GET    /cloud/account                      CloudAccountState
 *   GET    /cloud/usage?from&to                CloudUsage
 *   GET    /cloud/templates/:name              { exists }
 *   GET    /cloud/instances                    { data: CloudInstance[] }
 *   POST   /cloud/instances                    CloudInstance (create)
 *   GET    /cloud/instances/:id                CloudInstance
 *   DELETE /cloud/instances/:id                { deleted: true }
 *   POST   /cloud/instances/:id/sleep          { status }
 *   POST   /cloud/instances/:id/start          { status }
 *   POST   /cloud/instances/:id/stop           { status }
 *   POST   /cloud/instances/:id/idle           { status }   the computer asks to be slept
 *   POST   /cloud/instances/:id/update         { status, templateVersion }
 *   POST   /cloud/instances/:id/resize         { status }
 *   POST   /cloud/instances/:id/backups        { id, created, sizeBytes }
 *   PUT    /cloud/instances/:id/auto-sleep     { ok: true }
 *   POST   /cloud/instances/:id/public-ports   { port, url }
 *   POST   /cloud/instances/:id/fork           CloudInstance (copy)
 *   POST   /cloud/instances/:id/signed-url     { url, expiresAt }
 *   PUT    /cloud/instances/:id/name           { ok: true }
 *   PUT    /cloud/instances/:id/metadata       { ok: true }
 *   POST   /cloud/instances/:id/exec           { exitCode, stdout, stderr }
 *
 * `POST /cloud/instances/:id/start` with `{ reason: "push_work" }` is the one
 * wake allowed at 0 hours: free, short, once a day per computer.
 * `DELETE /cloud/instances/:id` takes `{ who, reason }`, recorded in the log.
 * `POST /cloud/instances/:id/resize` needs `{ computerIdle: true }` to grow the
 * disk of a running computer (a disk grow restarts it).
 */

export const CLOUD_PATHS = {
  access: "/cloud/access",
  account: "/cloud/account",
  usage: "/cloud/usage",
  templates: "/cloud/templates",
  instances: "/cloud/instances",
} as const;

/** `/cloud/instances/:id` and its actions. */
export function cloudInstancePath(id: string, action?: string): string {
  const base = `${CLOUD_PATHS.instances}/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

/** Same shape as `CloudInstance` in `apps/desktop/.../cloudProvider.ts`. */
export type CloudInstance = {
  id: string;
  name: string | null;
  status: string;
  template: string | null;
  type: string | null;
  region: string | null;
  resources: { cpu: number; memory: number; disk: number } | null;
  url: string | null;
  pastDue: boolean;
  created: number | null;
  statusReason: { code: string | null; message: string | null } | null;
  metadata: Record<string, string>;
  autoSleep: boolean;
  idleTimeoutSeconds: number | null;
  publicPorts: Array<{ port: number; url: string; label: string | null }>;
};

export type CloudAccessResponse = { enabled: boolean };

/** `byDay` is always `{}`: the provider reports days only for the whole workspace. */
export type CloudUsage = {
  from: string | null;
  to: string | null;
  byInstance: Record<string, number>;
  byDay: Record<string, number>;
};

export type CloudExecResult = { exitCode: number; stdout: string; stderr: string };

/**
 * The hours warning state: `none`, `warn80`, `warn95`, or `zero` (out of hours
 * with extra hours off). Banners read this.
 */
export type CloudHoursState = "none" | "warn80" | "warn95" | "zero";

export type CloudAccountState = {
  /** What the person pays for. A `past_due` paid account still says `paid` here. */
  plan: "free" | "paid";
  /** The rules in force: `past_due` is `free` until a paid invoice. */
  rules: "free" | "paid";
  hours: {
    /** All in integer thousandths of a Small-hour. */
    includedMilli: number;
    usedMilli: number;
    leftMilli: number;
    percentUsed: number;
    state: CloudHoursState;
  };
  extraHours: { available: boolean; enabled: boolean; usedMilli: number };
  disk: { usedGb: number; limitGb: number | null };
  computers: { total: number; awake: number; limit: number };
  /** Inactive computers, soonest first; each is deleted at `deletesAt` unless used. */
  dueForDeletion: Array<{ instanceId: string; name: string | null; deletesAt: number }>;
  billing: {
    periodStart: number;
    periodEnd: number;
    stripeStatus: string | null;
    cancelAtPeriodEnd: boolean;
  };
};

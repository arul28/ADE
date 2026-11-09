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
 *   POST   /cloud/billing/checkout             { url }   409 `already_paid`
 *   POST   /cloud/billing/portal               { url }   409 `no_billing`
 *   POST   /cloud/billing/extra-hours          CloudAccountState   403 `needs_paid_plan`
 *   GET    /cloud/chats?machine&project&limit&cursor   { chats: CloudChatRow[], nextCursor }
 *   GET    /cloud/chats/:machine/:chat?before&limit     CloudChatTranscriptPage
 *   PUT    /cloud/chats/:machine/:chat/parts/:seq       CloudChatPartResponse   (from the computer)
 *   DELETE /cloud/chats/:machine/:chat                  { deleted }
 *   DELETE /cloud/chats/:machine/lanes/:lane            { deleted }
 *
 * `POST /cloud/instances/:id/start` with `{ reason: "push_work" }` is the one
 * wake allowed at 0 hours: free, short, once a day per computer.
 * `DELETE /cloud/instances/:id` takes `{ who, reason }`, recorded in the log.
 * `POST /cloud/instances/:id/resize` needs `{ computerIdle: true }` to grow the
 * disk of a running computer (a disk grow restarts it).
 * `POST /cloud/billing/extra-hours` takes `{ enabled }`, on a paid plan only.
 * The checkout and portal URLs open in the person's browser and come back to
 * a plain page; read `GET /cloud/account` again to see what changed.
 */

export const CLOUD_PATHS = {
  access: "/cloud/access",
  account: "/cloud/account",
  usage: "/cloud/usage",
  templates: "/cloud/templates",
  instances: "/cloud/instances",
  billingCheckout: "/cloud/billing/checkout",
  billingPortal: "/cloud/billing/portal",
  billingExtraHours: "/cloud/billing/extra-hours",
  chats: "/cloud/chats",
} as const;

/** `/cloud/instances/:id` and its actions. */
export function cloudInstancePath(id: string, action?: string): string {
  const base = `${CLOUD_PATHS.instances}/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

/** `/cloud/chats/:machine/:chat`, plus `/parts/:seq` for an upload. */
export function cloudChatPath(machineKey: string, chatId: string, seq?: number): string {
  const base = `${CLOUD_PATHS.chats}/${encodeURIComponent(machineKey)}/${encodeURIComponent(chatId)}`;
  return seq === undefined ? base : `${base}/parts/${seq}`;
}

/** `/cloud/chats/:machine/lanes/:lane`. */
export function cloudChatLanePath(machineKey: string, laneId: string): string {
  return `${CLOUD_PATHS.chats}/${encodeURIComponent(machineKey)}/lanes/${encodeURIComponent(laneId)}`;
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
    /** Banner: a failed payment, or a plan a paid invoice just brought back. */
    notice: "past_due" | "restored" | null;
  };
};

/** Largest part of a chat the server accepts, in bytes of its text. */
export const CLOUD_CHAT_MAX_PART_BYTES = 8 * 1024 * 1024;
/** Most stored bytes one account's saved chats may take. Past it, saves are refused (and logged). */
export const CLOUD_CHAT_MAX_ACCOUNT_BYTES = 2 * 1024 * 1024 * 1024;
export const CLOUD_CHAT_MAX_PAGE_PARTS = 12;

/** What the computer sends with a part: the chat's row in the list. */
export type CloudChatRowInput = {
  title: string | null;
  laneId: string | null;
  laneName: string | null;
  status: string | null;
  toolType: string | null;
  provider: string | null;
  model: string | null;
  /** The repo identity (`normalizeGitRemoteIdentity`), so a window lists its own project's chats. */
  projectKey: string | null;
  /** The computer's own id and folder for that project, to address a send to it. */
  projectId: string | null;
  projectRoot: string | null;
  lastActivityAt: string | null;
};

export type CloudChatRow = CloudChatRowInput & {
  machineKey: string;
  chatId: string;
  instanceId: string | null;
  lastSeq: number;
  updatedAt: number;
};

/** `lastSeq` is what the server holds now; replay rules are in `chats.ts`. */
export type CloudChatPartResponse = { ok: true; lastSeq: number };

export type CloudChatTranscriptPage = {
  chat: CloudChatRow;
  /** Newest part first. Each `text` is JSON lines of chat events. */
  parts: Array<{ seq: number; text: string }>;
  hasMore: boolean;
  /** Pass as `before` for the next older page. Null at the start of the chat. */
  nextBefore: number | null;
};

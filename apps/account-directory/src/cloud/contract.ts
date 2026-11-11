/**
 * The ADE Cloud routes this Worker serves. Paths and response shapes only:
 * nothing here imports the Worker, so the desktop can `import type` it.
 *
 * Every route takes the account token as a bearer. A caller not on the access
 * list gets 404 `not_found` from everything except `GET /cloud/access`. Errors
 * are `{ error: { code, message } }` and `message` is one plain sentence.
 *
 *   GET    /cloud/access                       { enabled }
 *   GET    /cloud/account                      CloudAccountState
 *   GET    /cloud/templates/:name              { exists }
 *   GET    /cloud/instances                    { data: CloudInstance[] }
 *   POST   /cloud/instances                    CloudInstance (create)
 *   GET    /cloud/instances/:id                CloudInstance
 *   DELETE /cloud/instances/:id                { deleted: true }
 *   POST   /cloud/instances/:id/sleep          { status }
 *   POST   /cloud/instances/:id/start          { status }
 *   POST   /cloud/instances/:id/stop           { status }
 *   POST   /cloud/instances/:id/idle           { status }   the computer asks to be slept
 *   POST   /cloud/instances/:id/update         { status, templateVersion }   409 `update_in_progress`
 *   GET    /cloud/instances/:id/update-check   CloudUpdateCheck   (from the computer)
 *   POST   /cloud/instances/:id/booted         CloudBootReportResult   (from the computer)
 *   POST   /cloud/instances/:id/resize         { status }
 *   POST   /cloud/instances/:id/backups        { id, created, sizeBytes }
 *   PUT    /cloud/instances/:id/auto-sleep     { ok: true }
 *   POST   /cloud/instances/:id/public-ports   { port, url }
 *   POST   /cloud/instances/:id/fork           CloudInstance (copy)
 *   POST   /cloud/instances/:id/signed-url     { url, expiresAt }
 *   PUT    /cloud/instances/:id/name           { ok: true }
 *   PUT    /cloud/instances/:id/metadata       { ok: true }
 *   POST   /cloud/instances/:id/exec           { exitCode, stdout, stderr }
 *   POST   /cloud/billing/checkout             CloudCheckoutResult   409 `already_paid`
 *   POST   /cloud/billing/portal               { url }   409 `no_billing`
 *   POST   /cloud/billing/extra-hours          CloudAccountState   403 `needs_paid_plan`
 *   POST   /cloud/billing/extra-disk           CloudAccountState   403 `needs_paid_plan`, 409 `disk_over_plan` (404 while extra disk isn't set up)
 *   GET    /cloud/chats?machine&project&limit&cursor   { chats: CloudChatRow[], nextCursor }
 *   GET    /cloud/chats/:machine/:chat?before&limit     CloudChatTranscriptPage
 *   PUT    /cloud/chats/:machine/:chat/parts/:seq       CloudChatPartResponse   (from the computer)
 *   DELETE /cloud/chats/:machine/:chat                  { deleted }
 *   DELETE /cloud/chats/:machine/lanes/:lane            { deleted }
 *
 * `POST /cloud/instances/:id/start` with `{ reason: "push_work" }` is the one
 * wake allowed at 0 hours, or on the free plan with more disk than it has
 * (`over_plan_disk`): free, short, once a day per computer.
 * `DELETE /cloud/instances/:id` takes `{ who, reason }`, recorded in the log.
 * `POST /cloud/instances` with `{ moveFromInstanceId }` gives the new computer
 * that computer's disk (a move), under the same plan limits.
 * `POST /cloud/instances/:id/resize` needs `{ computerIdle: true }` to grow the
 * disk of a running computer (a disk grow restarts it).
 * `POST /cloud/billing/extra-hours` takes `{ enabled }`, on a paid plan only.
 * `POST /cloud/billing/checkout` takes `{ plan: "plus" | "pro" }` (Plus when
 * left out; any other value, or Pro while it isn't set up, is a 400) and
 * answers `{ url }` to open. On a paid account asking for the
 * other plan it changes the plan itself and answers `{ url: null, change }`:
 * `now` for an upgrade (charged now for the rest of the period; 402
 * `payment_failed` when the card is declined), `next_period` for a downgrade
 * (Pro's hours and limits stay until the period ends; refused with 409
 * `disk_over_plan` while the computers hold more than Plus's disk, unless
 * extra disk is on and fits its limit). The billing portal can't switch plans
 * on a subscription with more than one item.
 * `POST /cloud/billing/extra-disk` takes `{ enabled, monthlyLimitUsd }`
 * (`monthlyLimitUsd` a whole number from 1 to 1000, needed to turn it on).
 * Turning it off while the computers hold more than the plan's disk is
 * refused with `disk_over_plan`.
 * A disk refusal is `disk_limit` (or `needs_paid_plan` on the free plan) with
 * `error.reason` (`CloudDiskRefusalReason`).
 * A wake, exec, update or new timed wake on the free plan (a cancelled plan
 * included, never `past_due`) with more disk than it has is refused with 402
 * `over_plan_disk`; timed wakes already set are deleted, as at 0 hours.
 * Deleting a computer always works.
 * `POST /cloud/instances` takes `{ channel: "stable" | "beta" }` (an Alpha
 * build sends `beta`; left out is `stable`): the computer starts from that
 * channel's image and follows it. A copy follows its original's channel.
 * `POST /cloud/instances/:id/update` moves the computer to its channel's
 * image. `{ reason: "idle", computerIdle: true }` is the computer updating
 * itself: refused unless it is running, and a no-op (`started: false`) unless
 * it is behind the image a passed check allowed. One update at a time.
 * `POST /cloud/instances/:id/booted` takes `{ adeVersion }`; every brain start
 * sends it, and it settles a waiting update.
 * `POST /cloud/instances/:id/resize` takes `{ origin: "auto" }` from the
 * computer's own disk grower, so analytics can tell it from a person's grow.
 * The checkout and portal URLs open in the person's browser and come back to
 * a plain page; read `GET /cloud/account` again to see what changed.
 */

/** "$1", "$2.50": cents as people read money, on the server and in ADE. */
export function formatCloudCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/** Why no computer wakes on the free plan above its disk (`over_plan_disk`), said the same by the server and ADE. */
export function overPlanDiskSentence(usedGb: number, freeGb: number): string {
  return `Your computers use ${usedGb} GB and the free plan has ${freeGb} GB at one time. Delete a computer, or get Plus.`;
}

export const CLOUD_PATHS = {
  access: "/cloud/access",
  account: "/cloud/account",
  templates: "/cloud/templates",
  instances: "/cloud/instances",
  billingCheckout: "/cloud/billing/checkout",
  billingPortal: "/cloud/billing/portal",
  billingExtraHours: "/cloud/billing/extra-hours",
  billingExtraDisk: "/cloud/billing/extra-disk",
  chats: "/cloud/chats",
} as const;

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
  /** Why the last lifecycle action failed; null when nothing failed. */
  statusReason: { code: string | null; message: string | null } | null;
  /** What ADE set at create: tagged with `ade_request_id`, and with `ade_machine_key` once the machine joins. */
  metadata: Record<string, string>;
  /** The provider's own idle sleep: on, and after how many seconds with no traffic through the machine's URLs. */
  autoSleep: boolean;
  idleTimeoutSeconds: number | null;
  /** The machine's public ports (unauthenticated URLs); ADE's wake URL is one of them. */
  publicPorts: Array<{ port: number; url: string; label: string | null }>;
  /*
   * ADE's own update facts (`updates.ts`). Servers before updates leave them
   * out; the provider's `template` is only the image's name.
   */
  /** The channel it follows, picked by the app that made it. */
  channel?: CloudUpdateChannel;
  /** The image it runs, `ade@N`. */
  templateVersion?: string | null;
  /** The channel's current image: what it updates to. */
  targetTemplate?: string | null;
  /** Whether it updates itself: its channel's automatic updates are on (`auto_update_<channel>` set and not `off`). */
  autoUpdate?: boolean;
  /** null when settled: `updating` until it reports in, `failed` after a rollback or a failed one. */
  updateState?: CloudUpdateState | null;
  /** When it last reported in on a new image (ms). */
  updatedAt?: number | null;
  /** Why the last update failed, one plain sentence; null unless `updateState` is `failed`. */
  updateError?: string | null;
};

/** The update channel a computer follows. A client's `alpha` counts as `beta`. */
export type CloudUpdateChannel = "stable" | "beta";
export type CloudUpdateState = "updating" | "failed";
/** Why an update started: a person, the idle computer itself, the cron while it slept, or the rollback. */
export type CloudUpdateReason = "manual" | "idle" | "asleep" | "rollback";

/** `GET /cloud/instances/:id/update-check`: whether the computer should update itself now. */
export type CloudUpdateCheck = {
  behind: boolean;
  channel: CloudUpdateChannel;
  templateVersion: string | null;
  targetTemplate: string | null;
  updateState: CloudUpdateState | null;
};

/** `POST /cloud/instances/:id/booted`: it woke only for an update, so it may sleep at its first idle check. */
export type CloudBootReportResult = { ok: true; sleepWhenIdle: boolean };

/** What `POST /cloud/billing/checkout` answers. */
export type CloudPaidPlanId = Exclude<CloudPlanId, "free">;
/** When a switch between Plus and Pro applies: an upgrade now, a downgrade at the period end. */
export type CloudPlanChangeTiming = "now" | "next_period";
export type CloudCheckoutResult = { url: string } | { url: null; change: CloudPlanChangeTiming };

export type CloudExecResult = { exitCode: number; stdout: string; stderr: string };

/**
 * The hours warning state: `none`, `warn80`, `warn95`, or `zero` (out of hours
 * with extra hours off). Banners read this.
 */
export type CloudHoursState = "none" | "warn80" | "warn95" | "zero";

export type CloudPlanId = "free" | "plus" | "pro";

/** The four sizes of the main list. */
export type CloudTierId = "small" | "medium" | "large" | "xlarge";

/**
 * What a plan includes. `diskGb` and `computerLimit` are what the account may
 * have at one time, shared by all its computers; they are not monthly allowances.
 */
export type CloudPlanFacts = { includedMilli: number; computerLimit: number; diskGb: number; priceUsd: number };

/** The sizes and plans, so no client carries its own copy. A rate is `multiplierMilli / 1000` of a Small computer. */
export type CloudCatalog = {
  sizes: Array<{
    type: "default" | "vm";
    cpu: number;
    memoryGb: number;
    multiplierMilli: number;
    /** One of the four sizes of the main list, or null for the other four. Older servers leave it out. */
    tier?: CloudTierId | null;
    label?: string;
    /** How far the disk may grow at this size. */
    diskMaxGb?: number;
  }>;
  /**
   * `paid` is Plus, kept for builds that know only two plans. Servers before
   * Pro send only `free` and `paid` (and no `priceUsd`): a client offers Pro
   * only when `pro` is here, because such a server sells Plus for any plan asked.
   */
  plans: { free: CloudPlanFacts; paid: CloudPlanFacts; plus?: CloudPlanFacts; pro?: CloudPlanFacts };
  diskStepGb: number;
  /** Plus's price, for builds that know only two plans. */
  paidPriceUsd: number;
  /** What one extra Small-hour costs, before the volume price. */
  extraHourCents: number;
  /** What 10 GB of extra disk costs for a month, counted by the day. Servers before extra disk leave it out. */
  extraDiskCentsPer10GbMonth?: number;
};

/**
 * Extra disk (paid plans): disk above the plan's, counted by the day.
 * - `off`: never decided. The first grow past the plan's disk is refused with reason `needs_approval`, and ADE asks once.
 * - `asked`: the person said no. A grow past the plan's disk is refused with reason `extra_off`.
 * - `on`: allowed while a full month of it stays inside `monthlyLimitCents`;
 *   what is billed in a period never passes that limit.
 */
export type CloudExtraDiskState = "off" | "asked" | "on";

/**
 * Why a disk grow, a create or a copy was refused with code `disk_limit`
 * (`error.reason`). A client that doesn't know a reason shows `error.message`,
 * which is always a plain sentence.
 * - `plan_disk`: past the free plan's disk (the code is then `needs_paid_plan`).
 * - `needs_approval`: past a paid plan's disk with extra disk never decided.
 * - `extra_off`: past a paid plan's disk with extra disk turned down.
 * - `monthly_limit`: past the monthly limit the person set for extra disk.
 * - `tier_limit`: past what this size's disk can grow to.
 * - `unavailable`: ADE Cloud isn't growing disks right now.
 */
export type CloudDiskRefusalReason = "plan_disk" | "needs_approval" | "extra_off" | "monthly_limit" | "tier_limit" | "unavailable";

export type CloudAccountState = {
  /** What the person pays for. A `past_due` paid account still says `paid` here. */
  plan: "free" | "paid";
  /** The rules in force: `past_due` is `free` until a paid invoice. */
  rules: "free" | "paid";
  /** Which plan: `plus` or `pro` when `plan` is `paid` (a `past_due` one included). Older servers leave it out. */
  planId?: CloudPlanId;
  hours: {
    /** All in integer thousandths of a Small-hour. */
    includedMilli: number;
    usedMilli: number;
    leftMilli: number;
    percentUsed: number;
    state: CloudHoursState;
  };
  extraHours: { available: boolean; enabled: boolean; usedMilli: number };
  /** Absent from older servers and while extra disk isn't set up. `usedCents` is this period's billable extra disk so far. */
  extraDisk?: { available: boolean; state: CloudExtraDiskState; monthlyLimitCents: number | null; usedCents: number };
  /**
   * Disk all computers hold at one time. `limitGb` is the plan's disk; null
   * only from servers before plans, where each free computer has its own.
   */
  disk: { usedGb: number; limitGb: number | null };
  computers: { total: number; awake: number; limit: number };
  /** Inactive computers, soonest first; each is deleted at `deletesAt` unless used. */
  dueForDeletion: Array<{ instanceId: string; name: string | null; deletesAt: number }>;
  /** Computers deleted in the last 90 days that had any use, whose ADE rows may still be on the account. */
  deletedInstanceIds: string[];
  catalog: CloudCatalog;
  billing: {
    periodStart: number;
    periodEnd: number;
    stripeStatus: string | null;
    cancelAtPeriodEnd: boolean;
    /** A plan that starts with the next period (a downgrade to Plus); older servers leave it out. */
    nextPlanId?: CloudPlanId | null;
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

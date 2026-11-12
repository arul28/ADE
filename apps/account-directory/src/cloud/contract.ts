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
 *   POST   /cloud/instances/:id/disk-usage     { ok: true }   (from the computer: CloudDiskUsageReport)
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
 *   GET    /cloud/lanes/without-computer                { lanes: CloudLaneWithoutComputer[] }
 *   DELETE /cloud/lanes/without-computer/:lane          { forgotten }
 *
 * `POST /cloud/instances/:id/start` with `{ reason: "push_work" }` is the one
 * wake allowed at 0 hours, or on the free plan with more disk than it has
 * (`over_plan_disk`): free, short, once a day per computer.
 * `DELETE /cloud/instances/:id` takes `{ who, reason }`, recorded in the log.
 * With `{ keepLane: { branchRef } }` the lane the computer was made for
 * (its lane metadata) stays as a lane without a computer; the 30-day rule
 * keeps the lane the same way. A new computer made for that lane id ends it.
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
 * (Pro's hours and limits stay until the period ends). A downgrade is never
 * refused: over Plus's computers or disk, it answers `cleanup`, what Plus's
 * limits will free (`CloudPlanCleanup`). The billing portal can't switch plans
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
  lanesWithoutComputer: "/cloud/lanes/without-computer",
  /** `GET`: this account's `CloudReferralSummary`. */
  referrals: "/cloud/referrals",
  /** `POST { code }` (a pasted link or a bare code): `CloudInviteRedeemResult`, or `invite_refused` with a `CloudInviteRefusalReason`. */
  referralsRedeem: "/cloud/referrals/redeem",
} as const;

/**
 * Sent by the desktop and a machine's brain with every `/cloud` call: SHA-256
 * of `CLOUD_COMPUTER_ID_DOMAIN:` plus the OS machine id (64 hex), or
 * `unreadable` when the OS gave none. An ADE Cloud computer sends nothing.
 * The server keys it again before keeping it (`freePlan.ts`).
 */
export const CLOUD_COMPUTER_HEADER = "x-ade-computer";
/** `darwin`, `win32` or `linux`, next to the header above. */
export const CLOUD_COMPUTER_PLATFORM_HEADER = "x-ade-computer-platform";
/** The fixed, ADE-wide salt of the computer id. Not per account: one computer is one id for every account. */
export const CLOUD_COMPUTER_ID_DOMAIN = "ade-cloud-free-plan-computer-v1";
export const CLOUD_COMPUTER_UNREADABLE = "unreadable";

/**
 * The metadata that links a computer to the one lane it was made for. The
 * desktop writes it at the create; the server reads it when the computer goes
 * but its lane stays (`keepLane`, the 30-day rule).
 */
export const CLOUD_LANE_METADATA = {
  /** The lane this computer was made for (the launch's reserved lane id). */
  laneId: "ade_lane_id",
  /** The lane's name when the computer was made. The lane may be renamed later; this is not kept in step. */
  laneName: "ade_lane_name",
  /** The project's normalized git origin (`github.com/owner/repo`). */
  projectOrigin: "ade_project_origin",
  /** The lane's branch, once the computer's ADE named it. */
  branch: "ade_lane_branch",
} as const;

/**
 * A lane whose computer is gone while the lane stays: freed by the person
 * ("Keep the lane on a fresh computer") or removed after 30 days unused. Its
 * chats stay readable from the saved copy. The next send to it makes a new
 * computer on the same branch, and that computer's create ends this record.
 */
export type CloudLaneWithoutComputer = {
  laneId: string;
  laneName: string;
  projectOrigin: string | null;
  /** The branch the lane works on, or null when ADE never learned it. */
  branchRef: string | null;
  /**
   * `freed`: the person kept the lane on a fresh computer. `inactive`: the
   * 30-day rule removed its computer. `plan_limit`: a cheaper plan's limits
   * removed it, after its work was pushed (`planCleanup.ts`).
   */
  reason: "freed" | "inactive" | "plan_limit";
  /** The size the old computer had. */
  type: "default" | "vm";
  cpu: number;
  memoryGb: number;
  formerInstanceId: string;
  /** The old computer's ADE machine key: its saved chats are filed under it. */
  formerMachineKey: string | null;
  /** When the computer went, in ms. */
  since: number;
};

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
  /*
   * ADE's own use facts (`diskUsage.ts`), from the computer's own reports and
   * the meter. Servers before them leave them out.
   */
  /** When it last did work (its own report), else when it was last awake (ms); null if never. */
  lastActiveAt?: number | null;
  /** What uses its disk, as it last measured while awake; null before its first measure. */
  diskUsage?: CloudDiskUsage | null;
  /** Its lane's work as it last read it while awake (for "Safe to delete"); null before its first report. */
  laneWork?: CloudLaneWork | null;
};

/**
 * A lane computer's own read of its work at its idle step: whether anything
 * is only on the computer (uncommitted changes or unpushed commits, in any
 * lane on it), and the state of the lane's pull request.
 */
export type CloudLaneWork = {
  checkedAt: number;
  unpushed: boolean;
  prState: "draft" | "open" | "merged" | "closed" | null;
};

/** What a part of a computer's disk holds. `caches` and `docker` can be cleared from ADE. */
export const CLOUD_DISK_USAGE_KINDS = ["repository", "dependencies", "docker", "android", "caches", "other"] as const;
export type CloudDiskUsageKind = (typeof CLOUD_DISK_USAGE_KINDS)[number];

/** One part of a computer's disk, as the computer measured it. */
export type CloudDiskUsageItem = { kind: CloudDiskUsageKind; label: string; gb: number; clearable: boolean };

/** What uses a computer's disk, with when it was measured (ms). */
export type CloudDiskUsage = { measuredAt: number; totalGb: number; items: CloudDiskUsageItem[] };

/**
 * `POST /cloud/instances/:id/disk-usage`, from the computer at its idle step:
 * when it last did work, and a new measure when it took one (at most every
 * few hours). Most `CLOUD_DISK_USAGE_MAX_ITEMS` items.
 */
export type CloudDiskUsageReport = { lastActiveAt: number | null; usage: CloudDiskUsage | null; work?: CloudLaneWork | null };
export const CLOUD_DISK_USAGE_MAX_ITEMS = 12;

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
/**
 * A switch between paid plans answers `url: null`. A downgrade over the
 * cheaper plan's limits is never refused: it answers what those limits will
 * free (`cleanup`), which ADE shows as the warning.
 */
export type CloudCheckoutResult = { url: string } | { url: null; change: CloudPlanChangeTiming; cleanup?: CloudPlanCleanup | null };

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
  /**
   * Hours the meter settled over the last `days` whole UTC days, for the
   * "your hours last until" estimate. Older servers leave it out.
   */
  recentUse?: { days: number; usedMilli: number };
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
  /**
   * The computers a cheaper plan's limits will free (`planCleanup.ts`): while
   * a downgrade or a cancel waits for the period end, and once the cheaper
   * plan is on and the account is still over it. Null when nothing goes.
   * Older servers leave it out.
   */
  planCleanup?: CloudPlanCleanup | null;
  /**
   * What moving to a cheaper plan now would free, for the warning before the
   * change ("Move to Plus", cancel). Only plans that would free something.
   */
  downgradePreviews?: { plus?: CloudPlanCleanup; free?: CloudPlanCleanup };
  /** The last time a cheaper plan's limits freed computers, kept 14 days for a notice. */
  planCleanupDone?: CloudPlanCleanupDone | null;
  /** Timed wake-ups this period deleted because computers may not wake (0 hours, or the free plan over its disk). */
  timedWakesCancelled?: CloudTimedWakesCancelled | null;
  /**
   * Earned hours (referrals). Used after the plan's hours and before paid
   * extra hours; they never expire. `hours` above stays the plan's own hours.
   * Older servers leave it out.
   */
  earnedHours?: CloudEarnedHours;
  /** Whether this account gets the free plan's hours (one free plan per computer). Older servers leave it out. */
  freePlan?: CloudFreePlan;
  /** The account's invite link and what it earned. Older servers leave it out. */
  referral?: CloudReferralSummary;
};

/* ---- Referrals, earned hours and the free plan per computer (README "Referrals and the free plan") ---- */

/** Hours both accounts get when an invited friend's first chat runs on an ADE Cloud computer, in thousandths. */
export const CLOUD_REFERRAL_REWARD_MILLI = 20_000;
/** Rewards a referrer can get, ever. Past it the friend still gets theirs. */
export const CLOUD_REFERRAL_REWARD_LIMIT = 10;
/** Days after an ADE account is created that it may still enter an invite code. */
export const CLOUD_REFERRAL_ENTER_DAYS = 30;
/** `cloud_earned_hours.reason` of a referral's two grants; each one's `reference` is the friend's account. */
export const CLOUD_REFERRAL_REFERRER_REASON = "referral_referrer";
export const CLOUD_REFERRAL_FRIEND_REASON = "referral_friend";
/**
 * A deleted account's kept rows (referrals, earned hours, its free-plan
 * claim) carry `deleted:<sha256 of the Clerk id>` instead of the id
 * (`accountDeletion.ts`), so nothing kept names the person.
 */
export const CLOUD_DELETED_ACCOUNT_PREFIX = "deleted:";
/** Invite codes: this many characters of `CLOUD_INVITE_ALPHABET` (no 0/O/1/I/L). */
export const CLOUD_INVITE_CODE_LENGTH = 8;
export const CLOUD_INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** The invite page on the website; the link is this plus the code. */
export const CLOUD_INVITE_URL_BASE = "https://ade-app.dev/invite/";
/** What the website's "Open in ADE" button opens: the app fills the code in Settings › Account. */
export const CLOUD_INVITE_DEEPLINK_BASE = "ade://invite/";

export const cloudInviteLink = (code: string): string => `${CLOUD_INVITE_URL_BASE}${code}`;

/**
 * The code in what a person pasted: the invite link, the `ade://` link, or the
 * bare code, any case, with spaces or dashes. Null when it can't be one.
 */
export function parseCloudInviteCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (!text || text.length > 300) return null;
  const linked = text.match(/invite\/([^/?#\s]+)/i);
  if (linked) text = linked[1]!;
  const code = text.replace(/[\s-]+/g, "").toUpperCase();
  if (code.length !== CLOUD_INVITE_CODE_LENGTH) return null;
  for (const char of code) if (!CLOUD_INVITE_ALPHABET.includes(char)) return null;
  return code;
}

export type CloudEarnedHours = {
  /** Earned hours left now, after what this period already drew. Thousandths of a Small-hour. */
  leftMilli: number;
  /** What this period drew from earned hours so far. */
  usedThisPeriodMilli: number;
  /** Every earned hour ever granted. */
  grantedMilli: number;
};

/**
 * One free plan per physical computer.
 * - `unclaimed`: no computer holds this account's free plan yet; it gets the
 *   free hours, and the first computer it uses them from is claimed for it.
 *   An account used only from the phone or MCP stays here.
 * - `claimed`: a computer holds this account's free plan.
 * - `refused`: the computer it was used from already gave another account its
 *   free hours, so the free plan has 0 hours here. Paid plans, earned hours and
 *   extra hours still work. Using ADE from a computer of its own claims that one.
 */
export type CloudFreePlanState = "unclaimed" | "claimed" | "refused";

export type CloudFreePlan = {
  state: CloudFreePlanState;
  /** The one sentence for the dashboard while it matters (refused, on the free plan's rules); null otherwise. */
  sentence: string | null;
};

/** The dashboard's sentence for a refused free plan; the server passes `CLOUD_PLANS.plus.includedMilli` (`plans.ts`). */
export const cloudFreePlanRefusedSentence = (plusIncludedMilli: number): string =>
  `This computer already used another account's free hours. Plus gives you ${Math.round(plusIncludedMilli / 1000).toLocaleString("en-US")} hours a month.`;

export type CloudReferralSummary = {
  /** This account's invite code and link. */
  code: string;
  link: string;
  /** Friends who entered this account's code (any state). */
  friendsJoined: number;
  /** Rewards this account got as the referrer. */
  rewardsPaid: number;
  /** Referrer rewards left of `rewardLimit`. */
  rewardsLeft: number;
  rewardLimit: number;
  /** Hours per reward, in thousandths, for "You both get 20 hours". */
  rewardMilli: number;
  /** Every hour this account earned from referrals (as referrer and as friend). */
  hoursEarnedMilli: number;
  /** Whether this account may still enter someone's code (no referrer yet, inside its window). */
  canEnterCode: boolean;
  /** When the window to enter a code closes (ms); null when unknown or already referred. */
  enterCodeUntil: number | null;
  /** Whether this account entered someone's code. */
  hasReferrer: boolean;
  /** Where this account's own entered code stands, or null without one. */
  referredState: "pending" | "rewarded" | "refused" | null;
};

/**
 * Why `POST /cloud/referrals/redeem` refused a code (`error.reason`, code
 * `invite_refused`); `error.message` is the sentence to show.
 */
export const CLOUD_INVITE_REFUSAL_REASONS = ["invalid_code", "unknown_code", "own_code", "already_referred", "mutual", "too_late", "rate_limited"] as const;
/** `mutual`: the code's owner already entered this account's code; two accounts can't refer each other. */
export type CloudInviteRefusalReason = (typeof CLOUD_INVITE_REFUSAL_REASONS)[number];

export type CloudInviteRedeemResult = {
  result: "accepted";
  /** True when the reward was paid at once (the friend's first cloud chat had already run). */
  rewarded: boolean;
  referral: CloudReferralSummary;
};

/** `GET /invites/<code>` (public, rate-limited): the inviter's first name, or null when Clerk has none. */
export type CloudInviteLookup = { firstName: string | null };

/**
 * Days between a cheaper plan starting and ADE freeing what is over its
 * limits: time to delete computers by choice instead.
 */
export const CLOUD_PLAN_CLEANUP_GRACE_DAYS = 3;

/** One computer a cheaper plan frees: its lane (when it holds one), the branch its work goes to, its disk. */
export type CloudPlanCleanupComputer = {
  instanceId: string;
  /** The computer's own name. */
  name: string | null;
  /** The lane it holds; null for a computer made for no lane (deleted after its work is pushed). */
  laneName: string | null;
  branch: string | null;
  diskGb: number;
};

/**
 * What a cheaper plan's limits free. The oldest computers go first, until the
 * account fits the plan's computers and disk (disk extra disk covers counts as
 * fitting). Before each goes, its computer pushes every lane's work to its
 * branch on GitHub; a computer whose work can't all be pushed stays.
 */
export type CloudPlanCleanup = {
  /** The cheaper plan whose limits apply. */
  planId: CloudPlanId;
  /** Oldest first. */
  computers: CloudPlanCleanupComputer[];
  usedGb: number;
  limitGb: number;
  computerCount: number;
  computerLimit: number;
  /** When ADE frees them (ms); null in a preview, where it is `CLOUD_PLAN_CLEANUP_GRACE_DAYS` after the plan starts. */
  dueAt: number | null;
  /** The plain warning: what to free first, and what ADE does otherwise. */
  sentence: string;
};

export type CloudPlanCleanupDone = {
  at: number;
  planId: CloudPlanId;
  /** Freed: the work is on `branch` on GitHub. `laneKept` when the lane stays without a computer. */
  freed: Array<{ name: string; branch: string | null; laneKept: boolean }>;
  /** Kept because its work couldn't all be pushed; tried again each day while the account is over. */
  kept: Array<{ name: string; reason: string }>;
};

export type CloudTimedWakesCancelled = { at: number; count: number; reason: "out_of_hours" | "over_plan_disk" };

/** Why timed wake-ups were cancelled and how they come back: the email's body and ADE's notice. */
export function timedWakesCancelledSentence(notice: Pick<CloudTimedWakesCancelled, "count" | "reason">): string {
  const what = notice.count === 1 ? "A timed wake-up" : `${notice.count} timed wake-ups`;
  return notice.reason === "over_plan_disk"
    ? `${what} on your ADE Cloud computers won't run (a chat's scheduled wake-up or an automation's schedule), because your computers hold more disk than the free plan has, so they can't wake. Once you delete a computer or get Plus, each computer sets its next timed wake-up again the next time it runs.`
    : `${what} on your ADE Cloud computers won't run (a chat's scheduled wake-up or an automation's schedule), because you're out of ADE Cloud hours, so your computers can't wake. When your hours reset or you add hours, each computer sets its next timed wake-up again the next time it runs.`;
}

/** Each plan's name inside a sentence ("To fit the free plan", "Plus allows ..."): the server's emails and ADE say the same. */
export const CLOUD_PLAN_SENTENCE_NAMES: Readonly<Record<CloudPlanId, string>> = { free: "the free plan", plus: "Plus", pro: "Pro" };

/** What a cheaper plan's limits freed and kept, for ADE's notice after the run. */
export function planCleanupDoneSentence(done: CloudPlanCleanupDone): string {
  const parts: string[] = [];
  if (done.freed.length) {
    const list = done.freed.map((entry) => (entry.branch ? `${entry.name} (work on ${entry.branch})` : entry.name)).join(", ");
    const lanesKept = done.freed.filter((entry) => entry.laneKept).length;
    // Only a computer that held a lane keeps one: a computer made for no lane is simply gone.
    const kept = lanesKept === 0 ? ""
      : ` ${lanesKept === done.freed.length ? (lanesKept === 1 ? "Its lane and chats stay" : "Their lanes and chats stay") : (lanesKept === 1 ? "The lane among them and its chats stay" : "The lanes among them and their chats stay")}; the next message to a lane makes a new computer.`;
    parts.push(`To fit ${CLOUD_PLAN_SENTENCE_NAMES[done.planId]}, ADE pushed each lane's work to GitHub and removed ${done.freed.length === 1 ? "this computer" : "these computers"}: ${list}.${kept}`);
  }
  if (done.kept.length) {
    parts.push(`ADE kept ${done.kept.map((entry) => entry.name).join(", ")}, because its work couldn't all be pushed to GitHub. Push its work or delete it yourself; ADE tries again tomorrow.`);
  }
  return parts.join(" ");
}


/**
 * The warning for a cheaper plan's limits, said the same by the server, its
 * emails and ADE: "Free 23 GB first: Plus allows 40 GB and you use 63 GB. ..."
 */
export function planCleanupSentence(cleanup: Omit<CloudPlanCleanup, "sentence" | "dueAt">): string {
  const plan = CLOUD_PLAN_SENTENCE_NAMES[cleanup.planId];
  const parts: string[] = [];
  const overGb = cleanup.usedGb - cleanup.limitGb;
  const overComputers = cleanup.computerCount - cleanup.computerLimit;
  if (overGb > 0) parts.push(`Free ${overGb} GB first: ${plan} allows ${cleanup.limitGb} GB and you use ${cleanup.usedGb} GB.`);
  if (overComputers > 0) {
    parts.push(`Delete ${overComputers} ${overComputers === 1 ? "computer" : "computers"} first: ${plan} allows ${cleanup.computerLimit} at one time and you have ${cleanup.computerCount}.`);
  }
  const names = cleanup.computers.map((computer) => computer.laneName ?? computer.name ?? computer.instanceId);
  if (names.length) {
    const one = names.length === 1;
    parts.push(`Otherwise ADE pushes each lane's work to its branch on GitHub, then removes your oldest ${one ? "computer" : "computers"}: ${names.join(", ")}. ${one ? "Its lane and chats stay" : "Their lanes and chats stay"}, and the next message to a lane makes a new computer. A computer whose work can't be pushed stays.`);
  }
  return parts.join(" ");
}

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

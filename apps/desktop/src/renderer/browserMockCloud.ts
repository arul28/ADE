/**
 * Browser preview of the ADE Cloud dashboard: an account, its lane computers
 * and lanes kept without one. Fake data only (no real ids, emails or keys).
 *
 * `?mockCloud=<scenario>` turns it on. Without the flag nothing here runs.
 *  - `free` (default): Free plan, two lanes and one computer with no lane.
 *  - `empty`: Free plan, nothing made yet.
 *  - `plus`: Plus plan, six lanes, extra hours on, earned hours.
 *  - `pro`: Pro plan, a busy account over Plus's limits ("Move to Plus" asks first).
 *  - `downgrade`: Pro with a move to Plus waiting (made in the billing portal), over Plus.
 *  - `over`: Free plan in force, over its limits (a cancel made in the billing portal).
 *  - `full`: Free plan out of hours with the disk 92% full.
 *  - `blocked`: Free plan refused on this computer (another account used it).
 *  - `idle`: Free plan, one lane unused 2 days (deleted in 1 day, ignored files listed) and one whose computer the idle cleanup removed,
 *    with its saved work; Settings › ADE Cloud also lists saved work from a deleted project's lane.
 *  - `idlepaid`: Plus, one lane unused 7 days (deleted in 3 days, no ignored-files summary yet).
 *  - `idleheld`: Free plan, one lane ADE didn't delete because it couldn't save its work (over 50 MB).
 *  - `pastdue`: Plus with its last payment failed (free plan rules until it's paid).
 *  - `extradisk`: Plus with extra disk on, past the plan's 30 GB.
 *  - `upgraded`: Plus a moment after checkout, with this computer last seeing Free
 *    (79.1 free hours left): the "You're on Plus" confirmation shows once.
 *  - `emptyplus`: Plus with nothing made yet and no use this period.
 * On `free`, Get Plus lands the plan a moment later, as a checkout coming back does.
 * `&mockCloudAccess=off` answers "no ADE Cloud" (the hidden state).
 *
 * It runs after the sign-ins preview (`?mockSignIns=`), keeping its sign-in
 * calls and replacing only the account and computer reads.
 */
import {
  CLOUD_MACHINE_DEFAULT_NAME,
  cloudFreeGithubSentence,
  cloudFreePlanRefusedSentence,
  type CloudFreePlanGithubState,
  planCleanupSentence,
  type CloudAccountState,
  type CloudIgnoredFiles,
  type CloudMachine,
  type CloudMachinesResult,
  type CloudPlanCleanup,
} from "../shared/adeCloud";
import { githubRepoOf, type CloudLaneMachine, type CloudLaneWithoutComputer } from "../shared/cloudLaneLaunch";
import type {
  CloudKeptLaneRestoreArgs,
  CloudKeptLaneRestorePreview,
  CloudKeptLaneRestorePreviewArgs,
  CloudKeptLaneRestoreRecord,
} from "../shared/cloudKeptLaneRestore";

const mockRestores = new Map<string, { record: CloudKeptLaneRestoreRecord; startedAt: number; refused: boolean }>();
import {
  CLOUD_BACKUP_NOT_SAVED_SENTENCE,
  CLOUD_BACKUP_TOO_LARGE_SENTENCE,
  type CloudLaneBackup,
  type CloudLaneBackupFacts,
} from "../../../account-directory/src/cloud/contract";

/** A saved lane work for the preview: fake ids and sizes only. */
function mockBackup(facts: Pick<CloudLaneBackupFacts, "branchRef" | "laneName" | "projectKey" | "commits" | "files"> & { laneId: string; savedAt: number }): CloudLaneBackup {
  return {
    ...facts,
    machineKey: `mk-gone-${facts.laneId}`,
    instanceId: null,
    headSha: "1".repeat(40),
    snapshotSha: facts.files > 0 ? "2".repeat(40) : null,
    baseSha: "3".repeat(40),
    fingerprint: "f".repeat(64),
    bundleBytes: 48_000,
    patchBytes: 9_600,
    bundleParts: 1,
    patchParts: 1,
    restoredAt: null,
    restoredByMachineKey: null,
  };
}
import { CLOUD_PLAN_SEEN_STORAGE_KEY } from "./components/settings/cloudDashboard/cloudPlanMoment";

type Scenario = "free" | "empty" | "plus" | "pro" | "downgrade" | "over" | "full" | "blocked" | "idle" | "idlepaid" | "idleheld" | "pastdue" | "extradisk" | "upgraded" | "emptyplus";
const SCENARIOS: readonly Scenario[] = ["free", "empty", "plus", "pro", "downgrade", "over", "full", "blocked", "idle", "idlepaid", "idleheld", "pastdue", "extradisk", "upgraded", "emptyplus"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function param(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

const CATALOG: CloudAccountState["catalog"] = {
  sizes: [
    { type: "default", cpu: 2, memoryGb: 4, multiplierMilli: 1000, tier: "small", label: "Small", diskMaxGb: 12 },
    { type: "default", cpu: 4, memoryGb: 8, multiplierMilli: 2000, tier: "medium", label: "Medium", diskMaxGb: 20 },
    { type: "vm", cpu: 4, memoryGb: 8, multiplierMilli: 5000, tier: "large", label: "Large", diskMaxGb: 50 },
    { type: "vm", cpu: 4, memoryGb: 16, multiplierMilli: 8000, tier: "xlarge", label: "X-Large", diskMaxGb: 100 },
  ],
  plans: {
    free: { includedMilli: 100_000, diskGb: 12, priceUsd: 0, phoneMinutes: 60, extraHourCents: null, extraPhoneMinuteCents: null },
    paid: { includedMilli: 300_000, diskGb: 30, priceUsd: 5, phoneMinutes: 80, extraHourCents: 2, extraPhoneMinuteCents: 2.5 },
    plus: { includedMilli: 300_000, diskGb: 30, priceUsd: 5, phoneMinutes: 80, extraHourCents: 2, extraPhoneMinuteCents: 2.5 },
    pro: { includedMilli: 1_600_000, diskGb: 80, priceUsd: 20, phoneMinutes: 300, extraHourCents: 1.5, extraPhoneMinuteCents: 2.5 },
    max: { includedMilli: 5_000_000, diskGb: 175, priceUsd: 50, phoneMinutes: 800, extraHourCents: 1.2, extraPhoneMinuteCents: 2.5 },
  },
  diskStepGb: 4,
  paidPriceUsd: 5,
  extraHourCents: 2,
  extraDiskCentsPer10GbMonth: 200,
};

type LaneSpec = {
  id: string;
  lane: string | null;
  tier: "small" | "medium" | "large" | "xlarge";
  diskGb: number;
  state: CloudMachine["state"];
  lastActiveAgoMs: number | null;
  createdAgoMs: number;
  unpushed?: boolean;
  pr?: "open" | "merged" | null;
};

const SHAPES = {
  small: { type: "box", cpu: 2, memoryGb: 4, shapeId: "2x4", rate: 1 },
  medium: { type: "box", cpu: 4, memoryGb: 8, shapeId: "4x8", rate: 2 },
  large: { type: "vm", cpu: 4, memoryGb: 8, shapeId: "4x8", rate: 5 },
  xlarge: { type: "vm", cpu: 4, memoryGb: 16, shapeId: "4x16", rate: 8 },
} as const;

/**
 * The lane a mock computer holds. checkout-redesign is the lane
 * `?mockCloudLaneMachine=1` pairs (`browserMock.ts`). `?mockCloudChatLane=awake`
 * (or `asleep`) puts the demo's selected chat lane (`lane-auth`) on an awake (or
 * asleep) computer, so its chat header shows the cloud button and its menu.
 */
function mockLaneIdOf(spec: LaneSpec): string {
  const chatLane = param("mockCloudChatLane");
  if ((chatLane === "awake" && spec.id === "k3j9x0a1") || (chatLane === "asleep" && spec.id === "m2q8w1b2")) return "lane-auth";
  return spec.id === "k3j9x0a1" ? "cloud-lane-checkout" : `lane-${spec.id}`;
}

function machine(spec: LaneSpec, now: number): CloudLaneMachine {
  const shape = SHAPES[spec.tier];
  const repo = Math.min(spec.diskGb, Math.max(0.4, spec.diskGb * 0.18));
  const deps = Math.max(0, spec.diskGb * 0.42);
  const caches = Math.max(0, spec.diskGb * 0.22);
  const rest = Math.max(0, spec.diskGb - repo - deps - caches);
  return {
    instanceId: spec.id,
    name: spec.lane ? `ADE · ${spec.lane}` : CLOUD_MACHINE_DEFAULT_NAME,
    status: spec.state === "running" ? "running" : spec.state === "asleep" ? "sleeping" : spec.state,
    state: spec.state,
    type: shape.type,
    resources: { cpu: shape.cpu, memoryGb: shape.memoryGb, diskGb: spec.diskGb },
    shapeId: shape.shapeId,
    region: "us-east",
    hoursRate: shape.rate,
    pastDue: false,
    failure: null,
    machineKey: `mock-${spec.id}`,
    createdAtMs: now - spec.createdAgoMs,
    sleep: { mode: "idle", minutes: 3 } as unknown as CloudMachine["sleep"],
    diskFull: null,
    update: null,
    lastActiveAtMs: spec.lastActiveAgoMs == null ? null : now - spec.lastActiveAgoMs,
    awakeSinceMs: spec.state === "running" ? now - 42 * 60_000 : null,
    diskUsage: {
      measuredAt: now - 3 * HOUR,
      totalGb: spec.diskGb,
      items: [
        { kind: "repository", label: "Repository", gb: round(repo), clearable: false },
        { kind: "dependencies", label: "Dependencies", gb: round(deps), clearable: false },
        { kind: "caches", label: "Package and build caches", gb: round(caches), clearable: true },
        ...(shape.type === "vm" ? [{ kind: "docker" as const, label: "Docker images", gb: round(rest * 0.7), clearable: true }] : []),
        { kind: "other", label: "Other", gb: round(shape.type === "vm" ? rest * 0.3 : rest), clearable: false },
      ],
    },
    laneWork: { checkedAt: now - 3 * HOUR, unpushed: spec.unpushed ?? false, prState: spec.pr ?? null },
    lane: spec.lane ? { laneId: mockLaneIdOf(spec), laneName: spec.lane, projectOrigin: "github.com/acme/web" } : null,
  };
}

const round = (gb: number) => Math.round(gb * 10) / 10;

type Fixture = {
  planId: "free" | "plus" | "pro";
  usedMilli: number;
  lanes: LaneSpec[];
  without: Array<{ name: string; reason: "freed" | "inactive" | "idle_cleanup" | "plan_limit" }>;
  /** The idle cleanup's warnings, by lane id in `lanes` (`ignored: null` before the computer reported them). */
  idle?: Array<{ id: string; inMs: number; days: number; ignored: CloudIgnoredFiles | null; held?: string }>;
  extraHours?: boolean;
  earnedMilli?: number;
  blocked?: boolean;
  recentUsedMilli?: number;
  /** Pro with a move to Plus waiting, over Plus's limits: the cleanup notice and "Stay on Pro". */
  downgrade?: boolean;
  /** The plan in force is over its limits: new computers refused until the person picks. */
  over?: boolean;
  /** The last payment failed: the plan stays, its rules are the free plan's until paid. */
  pastDue?: boolean;
  /** Extra disk on, with a $10 monthly limit and some of it used. */
  extraDiskOn?: boolean;
  /** The period started an hour ago (a plan just bought). */
  freshPeriod?: boolean;
};

/** A CTO cloud home job that walks its three steps on timers. */
function mockCtoCloudHome(paid: boolean, failClone: boolean) {
  type Listener = (event: unknown) => void;
  const listeners = new Set<Listener>();
  let job: Record<string, any> | null = null;
  let timers: number[] = [];
  const emit = () => {
    if (!job) return;
    job.updatedAt = new Date().toISOString();
    const snapshot = { ...job, stages: job.stages.map((stage: Record<string, unknown>) => ({ ...stage })) };
    for (const listener of listeners) listener({ type: "updated", snapshot });
  };
  const stage = (id: string) => ({ id, status: "pending", startedAt: null, endedAt: null, percent: null, detail: null, error: null });
  const walk = (from: number) => {
    const ids = ["computer", "join", "clone"];
    ids.forEach((id, index) => {
      if (index < from) return;
      timers.push(window.setTimeout(() => {
        if (!job) return;
        const row = job.stages.find((entry: Record<string, unknown>) => entry.id === id);
        row.status = "running";
        row.detail = id === "computer" ? "Small · 2 CPU, 4 GB" : null;
        emit();
        timers.push(window.setTimeout(() => {
          if (!job) return;
          if (id === "clone" && failClone && !job.retried) {
            row.status = "failed";
            row.error = "The new computer can't read this repository. Check that ADE Cloud can sign in to GitHub for it, then retry.";
            job.phase = "failed";
            job.error = row.error;
            emit();
            return;
          }
          row.status = "done";
          if (id === "clone") {
            job.phase = "ready";
            job.instanceId = "mock-cto-instance";
            job.targetId = "mock-cto-target";
          }
          emit();
        }, 1_400));
      }, (index - from) * 1_600 + 200));
    });
  };
  const clear = () => { for (const timer of timers) window.clearTimeout(timer); timers = []; };
  const copyJob = () => (job ? { ...job, stages: job.stages.map((entry: Record<string, unknown>) => ({ ...entry })) } : null);
  return {
    ctoHome: async (request: { method: string; args: Record<string, unknown> }) => {
      console.info(`[browser mock] cloud.ctoHome ${request.method}`);
      if (request.method === "get") return copyJob();
      if (request.method === "start") {
        if (!paid) throw new Error("ADE Cloud as the CTO's home needs a paid plan. Upgrade to use it.");
        if (job) return copyJob();
        job = {
          jobId: "mock-cto-job",
          projectOrigin: githubRepoOf(typeof request.args?.originUrl === "string" ? request.args.originUrl : null)?.identity ?? "github.com/acme/web",
          phase: "running",
          stages: [stage("computer"), stage("join"), stage("clone")],
          error: null,
          warning: null,
          computerName: "CTO · acme/web",
          instanceId: null,
          machineKey: null,
          binding: null,
          targetId: null,
          reused: false,
          updatedAt: new Date().toISOString(),
        };
        walk(0);
        return copyJob();
      }
      if (request.method === "retry" && job) {
        job.phase = "running";
        job.error = null;
        job.retried = true;
        const failed = job.stages.find((entry: Record<string, unknown>) => entry.status === "failed");
        if (failed) { failed.status = "pending"; failed.error = null; }
        walk(2);
        emit();
        return copyJob();
      }
      if (request.method === "cancel" && job) {
        const current: Record<string, any> = job;
        clear();
        const done: Record<string, any> = { ...current, phase: "cancelled" };
        job = null;
        for (const listener of listeners) listener({ type: "removed", jobId: done.jobId, projectOrigin: done.projectOrigin });
        return done;
      }
      if (request.method === "finish") {
        job = null;
        return true;
      }
      return null;
    },
    onCtoHomeEvent: (cb: Listener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

function fixture(scenario: Scenario): Fixture {
  switch (scenario) {
    case "empty":
      return { planId: "free", usedMilli: 0, lanes: [], without: [] };
    case "plus":
      return {
        planId: "plus",
        usedMilli: 212_400,
        extraHours: true,
        earnedMilli: 40_000,
        recentUsedMilli: 61_000,
        lanes: [
          { id: "k3j9x0a1", lane: "checkout-redesign", tier: "medium", diskGb: 8, state: "running", lastActiveAgoMs: 0, createdAgoMs: 6 * DAY, pr: "open" },
          { id: "m2q8w1b2", lane: "android-push", tier: "large", diskGb: 10, state: "asleep", lastActiveAgoMs: 5 * HOUR, createdAgoMs: 9 * DAY, unpushed: true },
          { id: "p7r4t5c3", lane: "fix-login-redirect", tier: "small", diskGb: 4, state: "asleep", lastActiveAgoMs: 2 * DAY, createdAgoMs: 4 * DAY, pr: "merged" },
          { id: "z1x2c3d4", lane: "search-index", tier: "small", diskGb: 4, state: "running", lastActiveAgoMs: 0, createdAgoMs: DAY },
          { id: "q9w8e7f5", lane: "docs-pass", tier: "small", diskGb: 2, state: "asleep", lastActiveAgoMs: 19 * DAY, createdAgoMs: 30 * DAY, pr: "merged" },
        ],
        without: [{ name: "billing-webhooks", reason: "freed" }],
      };
    case "pro":
      return {
        planId: "pro",
        usedMilli: 640_000,
        recentUsedMilli: 140_000,
        extraHours: true,
        lanes: Array.from({ length: 11 }, (_, index): LaneSpec => ({
          id: `pro${index}x7k2`,
          lane: ["api-gateway", "ios-onboarding", "perf-sweep", "e2e-flake", "design-tokens", "billing-v2", "android-emu", "ml-ranker", "docs-site", "infra-terraform", "chat-search"][index]!,
          tier: (["medium", "large", "small", "small", "small", "medium", "xlarge", "large", "small", "medium", "small"] as const)[index]!,
          diskGb: [8, 12, 4, 4, 4, 8, 10, 6, 2, 2, 2][index]!,
          state: index % 3 === 0 ? "running" : "asleep",
          lastActiveAgoMs: index % 3 === 0 ? 0 : (index + 1) * 7 * HOUR,
          createdAgoMs: (index + 2) * DAY,
          pr: index % 4 === 0 ? "merged" : "open",
        })),
        without: [],
      };
    case "downgrade":
      return { ...fixture("pro"), downgrade: true };
    case "pastdue":
      return { ...fixture("plus"), pastDue: true, extraHours: false };
    case "extradisk":
      return {
        ...fixture("plus"),
        extraDiskOn: true,
        lanes: [...fixture("plus").lanes, { id: "x4d5i6s7", lane: "video-pipeline", tier: "large", diskGb: 6, state: "asleep", lastActiveAgoMs: 3 * HOUR, createdAgoMs: 2 * DAY }],
      };
    case "upgraded":
      return { planId: "plus", usedMilli: 200, freshPeriod: true, lanes: fixture("free").lanes.slice(0, 2), without: [] };
    case "emptyplus":
      return { planId: "plus", usedMilli: 0, freshPeriod: true, recentUsedMilli: 4_000, lanes: [], without: [] };
    case "over":
      return { ...fixture("plus"), planId: "free", usedMilli: 9_000, extraHours: false, earnedMilli: undefined, over: true };
    case "full":
      return {
        planId: "free",
        usedMilli: 100_000,
        recentUsedMilli: 9_000,
        lanes: [
          { id: "f1u2l3l4", lane: "monorepo-upgrade", tier: "small", diskGb: 8, state: "asleep", lastActiveAgoMs: 4 * HOUR, createdAgoMs: 12 * DAY, unpushed: true },
          { id: "f5u6l7l8", lane: "flaky-tests", tier: "small", diskGb: 3, state: "asleep", lastActiveAgoMs: 16 * DAY, createdAgoMs: 20 * DAY, pr: "merged" },
        ],
        without: [],
      };
    case "blocked":
      return { planId: "free", usedMilli: 0, lanes: [], without: [], blocked: true };
    case "idle":
    case "idleheld":
      return {
        planId: "free",
        usedMilli: 8_400,
        recentUsedMilli: 2_100,
        lanes: [
          { id: "a7c2e9k4", lane: "fix-login-redirect", tier: "small", diskGb: 4, state: "running", lastActiveAgoMs: 0, createdAgoMs: 2 * DAY, pr: "open" },
          { id: "i9d1l2e3", lane: "pricing-page", tier: "small", diskGb: 4, state: "asleep", lastActiveAgoMs: 2 * DAY + HOUR, createdAgoMs: 6 * DAY, unpushed: true },
        ],
        without: scenario === "idle" ? [{ name: "onboarding-copy", reason: "idle_cleanup" }] : [],
        idle: [{
          id: "i9d1l2e3",
          inMs: scenario === "idle" ? DAY - HOUR : 4 * HOUR,
          days: 3,
          ignored: { checkedAt: Date.now() - 2 * DAY, paths: [".env", ".env.local", "prisma/dev.db"], more: 2, rebuildable: 3 },
          ...(scenario === "idleheld" ? { held: `${CLOUD_BACKUP_NOT_SAVED_SENTENCE} pricing-page: ${CLOUD_BACKUP_TOO_LARGE_SENTENCE}` } : {}),
        }],
      };
    case "idlepaid":
      return {
        ...fixture("plus"),
        idle: [{ id: "q9w8e7f5", inMs: 3 * DAY - HOUR, days: 10, ignored: null }],
      };
    default:
      return {
        planId: "free",
        usedMilli: 6_200,
        recentUsedMilli: 1_900,
        lanes: [
          { id: "a7c2e9k4", lane: "fix-login-redirect", tier: "small", diskGb: 4, state: "running", lastActiveAgoMs: 0, createdAgoMs: 2 * DAY, pr: "open" },
          { id: "b8d3f0m5", lane: "android-ui", tier: "medium", diskGb: 4, state: "asleep", lastActiveAgoMs: 9 * HOUR, createdAgoMs: 5 * DAY },
          { id: "7z5o5rwcau", lane: null, tier: "medium", diskGb: 4, state: "asleep", lastActiveAgoMs: 12 * DAY, createdAgoMs: 14 * DAY },
        ],
        without: [],
      };
  }
}

function mockGithub(kind: string | null, now: number): Record<string, unknown> | null {
  const plus = CATALOG.plans.plus!.includedMilli;
  const held = (state: CloudFreePlanGithubState, oldEnoughAt: number | null, githubLogin: string | null) => ({
    state,
    oldEnoughAt,
    canUnlockWithCard: state === "too_new",
    githubLogin,
    sentence: cloudFreeGithubSentence(state, { oldEnoughAt, plusIncludedMilli: plus }),
  });
  if (kind === "none") return held("no_github", null, null);
  if (kind === "new") return held("too_new", now + 19 * DAY, "octo-new");
  if (kind === "used") return held("used", null, "octo-shared");
  if (kind === "checking") return held("checking", null, null);
  return null;
}

function periodBounds(now: number): { start: number; end: number } {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

function account(fix: Fixture, machines: CloudLaneMachine[], now: number): CloudAccountState {
  const plan = CATALOG.plans[fix.planId]!;
  // `?cloudGithub=none|new|used|checking`: the free plan's GitHub rules holding its hours.
  const github = fix.planId === "free" && !fix.blocked ? mockGithub(param("cloudGithub"), now) : null;
  const includedMilli = fix.blocked || github ? 0 : plan.includedMilli;
  const used = Math.min(fix.usedMilli, includedMilli);
  const left = Math.max(0, includedMilli - used);
  const percent = includedMilli > 0 ? Math.round((used / includedMilli) * 100) : 100;
  const period = fix.freshPeriod ? { start: now - HOUR, end: now - HOUR + 30 * DAY } : periodBounds(now);
  const diskUsed = machines.reduce((total, box) => total + (box.resources?.diskGb ?? 0), 0);
  const extra: Record<string, unknown> = {};
  if (fix.earnedMilli != null) extra.earnedHours = { leftMilli: fix.earnedMilli, usedThisPeriodMilli: 0, grantedMilli: fix.earnedMilli };
  extra.freePlan = fix.blocked
    ? { state: "refused", sentence: cloudFreePlanRefusedSentence(CATALOG.plans.plus!.includedMilli) }
    : { state: fix.planId === "free" ? "claimed" : "unclaimed", sentence: null };
  if (github) (extra.freePlan as Record<string, unknown>).github = github;
  const friends = fix.earnedMilli ? Math.round(fix.earnedMilli / 20_000) : 0;
  extra.referral = {
    code: "K7Q2-M9",
    link: "https://ade-app.dev/invite/K7Q2-M9",
    friendsJoined: friends + (fix.planId === "free" ? 0 : 1),
    rewardsPaid: friends,
    rewardsLeft: 10 - friends,
    rewardLimit: 10,
    rewardMilli: 20_000,
    hoursEarnedMilli: fix.earnedMilli ?? 0,
    canEnterCode: fix.planId === "free",
    enterCodeUntil: fix.planId === "free" ? now + 21 * DAY : null,
    hasReferrer: false,
    referredState: null,
  };
  return {
    plan: fix.planId === "free" ? "free" : "paid",
    rules: fix.planId === "free" || fix.pastDue ? "free" : "paid",
    planId: fix.planId,
    hours: {
      includedMilli,
      usedMilli: used,
      leftMilli: left,
      percentUsed: percent,
      state: left <= 0 ? "zero" : percent >= 95 ? "warn95" : percent >= 80 ? "warn80" : "none",
    },
    extraHours: { available: fix.planId !== "free", enabled: fix.extraHours === true, usedMilli: fix.planId === "pro" ? 4_200 : 0 },
    phone: fix.planId === "free" ? undefined : {
      access: "on",
      minutes: { included: plan.phoneMinutes ?? 0, used: 42, left: Math.max(0, (plan.phoneMinutes ?? 0) - 42) },
      state: "none",
      extra: { available: true, enabled: false, centsPerMinute: plan.extraPhoneMinuteCents ?? null, monthlyLimitCents: null, usedMinutes: 0, usedCents: 0 },
    },
    extraDisk: fix.planId === "free" ? undefined : fix.extraDiskOn
      ? { available: true, state: "on", monthlyLimitCents: 1000, usedCents: 140 }
      : { available: true, state: "off", monthlyLimitCents: null, usedCents: 0 },
    disk: { usedGb: fix.planId === "free" && fix.lanes.length === 2 && fix.usedMilli === 100_000 ? 11 : diskUsed, limitGb: plan.diskGb },
    computers: {
      total: machines.length,
      awake: machines.filter((box) => box.state === "running").length,
    },
    recentUse: fix.recentUsedMilli ? { days: 7, usedMilli: fix.recentUsedMilli } : undefined,
    dueForDeletion: (fix.idle ?? []).map((entry) => {
      const box = machines.find((candidate) => candidate.instanceId === entry.id);
      return {
        instanceId: entry.id,
        name: box?.name ?? null,
        deletesAt: entry.held ? now + DAY - 2 * HOUR : now + entry.inMs,
        laneName: box?.lane?.laneName ?? null,
        branch: box?.lane ? `ade/${box.lane.laneName}` : null,
        warnedAt: now - DAY,
        idleDays: entry.days,
        ignoredFiles: entry.ignored,
        held: entry.held ? { at: now - 2 * HOUR, reason: entry.held } : null,
      };
    }),
    deletedInstanceIds: [],
    catalog: CATALOG,
    billing: {
      periodStart: period.start,
      periodEnd: period.end,
      stripeStatus: fix.planId === "free" ? null : fix.pastDue ? "past_due" : "active",
      cancelAtPeriodEnd: false,
      nextPlanId: fix.downgrade ? "plus" : null,
      notice: fix.pastDue ? "past_due" : null,
    },
    ...(fix.downgrade ? { planCleanup: mockCleanup(machines, "plus", period.end) } : {}),
    ...(fix.over ? { planCleanup: mockCleanup(machines, "free", null) } : {}),
    ...(fix.planId === "pro" && !fix.downgrade ? { downgradePreviews: { plus: mockCleanup(machines, "plus", period.end), free: mockCleanup(machines, "free", period.end) } } : {}),
    ...extra,
  } as CloudAccountState;
}

/** What goes over `planId` (oldest first), as the server's `planCleanupFor` says it. */
function mockCleanup(machines: CloudLaneMachine[], planId: "free" | "plus" | "pro", startsAt: number | null): CloudPlanCleanup {
  const plan = CATALOG.plans[planId]!;
  const diskOf = (box: CloudLaneMachine) => box.resources?.diskGb ?? 0;
  const usedGb = machines.reduce((total, box) => total + diskOf(box), 0);
  const choices = [...machines].sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)).map((box) => ({
    instanceId: box.instanceId,
    name: box.name ?? null,
    laneName: box.lane?.laneName ?? null,
    branch: box.lane ? `ade/${box.lane.laneName}` : null,
    diskGb: diskOf(box),
    createdAt: box.createdAtMs ?? 0,
  }));
  const computers: typeof choices = [];
  let disk = usedGb;
  for (const choice of choices) {
    if (disk <= plan.diskGb) break;
    computers.push(choice);
    disk -= choice.diskGb;
  }
  const facts = { planId, usedGb, limitGb: plan.diskGb };
  return { ...facts, computers, choices, startsAt, freeing: null, sentence: planCleanupSentence(facts) };
}

/** Saved chats whose computer ADE deleted, for the `idle` preview: fake ids and text only. */
function mockDeletedComputerChats(now: number) {
  const projectKey = "github.com/acme-labs/browser-preview";
  const chat = (spec: { chatId: string; machineKey: string; laneId: string; laneName: string; title: string; agoMs: number; deletedAgoMs: number; reason: "idle" | "plan" }) => ({
    title: spec.title,
    laneId: spec.laneId,
    laneName: spec.laneName,
    status: "ended",
    toolType: "claude-chat",
    provider: "claude",
    model: "claude-opus-5-5",
    projectKey,
    projectId: "browser-preview",
    projectRoot: "/home/ade/work/browser-preview",
    lastActivityAt: new Date(now - spec.agoMs).toISOString(),
    machineKey: spec.machineKey,
    chatId: spec.chatId,
    instanceId: `inst-${spec.laneId}`,
    lastSeq: 1,
    updatedAt: now - spec.agoMs,
    computer: { state: "deleted" as const, deletedAt: now - spec.deletedAgoMs, reason: spec.reason },
  });
  const chats = [
    chat({ chatId: "saved-pricing-1", machineKey: "mk-gone-pricing", laneId: "lane-pricing-page", laneName: "pricing-page", title: "Pricing page copy", agoMs: 3 * DAY, deletedAgoMs: DAY, reason: "idle" }),
    chat({ chatId: "saved-onboarding-1", machineKey: "mk-gone-lane-without-0", laneId: "lane-without-0", laneName: "onboarding-copy", title: "Onboarding copy pass", agoMs: 4 * DAY, deletedAgoMs: DAY, reason: "idle" }),
  ];
  const transcript = (row: (typeof chats)[number]) => [
    { sessionId: row.chatId, timestamp: new Date(row.updatedAt - 60_000).toISOString(), event: { type: "user_message", text: `Tidy up the ${row.laneName} text.` } },
    { sessionId: row.chatId, timestamp: new Date(row.updatedAt).toISOString(), event: { type: "text", text: "Done. I shortened the headings and fixed two typos." } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  return {
    list: async (args: { projectKey?: string | null }) => ({
      chats: chats.filter((row) => !args.projectKey || row.projectKey === args.projectKey),
      nextCursor: null,
    }),
    read: async (args: { machineKey: string; chatId: string }) => {
      const row = chats.find((entry) => entry.chatId === args.chatId && entry.machineKey === args.machineKey);
      return row ? { chat: row, parts: [{ seq: 1, text: transcript(row) }], hasMore: false, nextBefore: null } : null;
    },
    delete: async (args: unknown) => {
      console.info("[browser mock] cloud.savedChats.delete", args);
    },
  };
}

export function applyBrowserMockCloud(ade: any): void {
  // `&mockTheme=<theme id>`: open the preview on that theme (light, dark, ...), for checking both.
  const theme = param("mockTheme");
  if (theme) {
    try {
      window.localStorage.setItem("ade.theme", theme);
    } catch {
      // Storage off: the preview keeps its theme.
    }
  }
  const requested = param("mockCloud") as Scenario | null;
  if (!requested) return;
  const scenario: Scenario = SCENARIOS.includes(requested) ? requested : "free";
  const accessOn = param("mockCloudAccess") !== "off";
  // Read once: the app routes away from the first URL and drops its query.
  const savedParam = param("mockCloudSaved");
  const now = Date.now();
  const fix = fixture(scenario);
  const machines = fix.lanes.map((spec) => machine(spec, now));
  let state = account(fix, machines, now);
  // `upgraded`: this computer last saw the account on Free, a period ago, with 79.1 hours left
  // (once per tab, as a real checkout coming back is seen once).
  if (scenario === "upgraded") {
    try {
      if (window.sessionStorage.getItem("ade.browserMock.planSeenSeed") !== "1") {
        window.sessionStorage.setItem("ade.browserMock.planSeenSeed", "1");
        window.localStorage.setItem(CLOUD_PLAN_SEEN_STORAGE_KEY, JSON.stringify({
          [state.referral?.code ?? "account"]: { planId: "free", periodStart: state.billing.periodStart - 30 * DAY, leftMilli: 79_100 },
        }));
      }
    } catch {
      // Storage off: the preview shows Plus without the confirmation.
    }
  }
  const without: CloudLaneWithoutComputer[] = fix.without.map((lane, index) => ({
    laneId: `lane-without-${index}`,
    laneName: lane.name,
    branchRef: `ade/${lane.name}`,
    since: now - DAY,
    reason: lane.reason,
    type: "default",
    cpu: 2,
    memoryGb: 4,
    // The preview project's own origin, so its Lanes and Work pages list these lanes.
    projectOrigin: "github.com/acme-labs/browser-preview",
    // The old computer: its saved chats are filed under this key.
    formerInstanceId: `inst-lane-without-${index}`,
    formerMachineKey: `mk-gone-lane-without-${index}`,
  }));
  // Lane backups at rest (`laneBackups.ts`): the kept lane's saved work, and one from a deleted project's lane.
  let backups: CloudLaneBackup[] = scenario === "idle" ? [
    mockBackup({ laneId: "lane-without-0", laneName: "onboarding-copy", branchRef: "ade/onboarding-copy", projectKey: "github.com/acme-labs/browser-preview", commits: 2, files: 3, savedAt: now - 3 * DAY }),
    mockBackup({ laneId: "lane-docs-search", laneName: "docs-search", branchRef: "ade/docs-search", projectKey: "github.com/acme/docs", commits: 4, files: 0, savedAt: now - 5 * DAY }),
  ] : [];
  const statusListeners = new Set<() => void>();
  const result = (): CloudMachinesResult => ({
    state: "ok",
    machines,
    instanceCount: machines.length,
    runningCount: machines.filter((box) => box.state === "running").length,
    account: state,
    deletedInstanceIds: [],
    message: null,
  });
  const base = ade.cloud ?? {};
  ade.cloud = {
    ...base,
    getStatus: async () => ({ connected: true, signedOut: false, instanceCount: machines.length, runningCount: result().runningCount, error: null }),
    listMachines: async () => result(),
    onStatusChanged: (cb: () => void) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    getAgentLimits: base.getAgentLimits ?? (async () => ({ maxShape: "4x8", machinesPerDay: 3, unattendedHours: true, askBeforeVm: true })),
    setAgentLimits: base.setAgentLimits ?? (async (limits: unknown) => limits),
    setExtraHours: async (enabled: boolean) => {
      state.extraHours = { ...state.extraHours, enabled };
      for (const listener of statusListeners) listener();
      return state;
    },
    setExtraPhoneMinutes: async (choice: { enabled: true; monthlyLimitUsd: number | null } | { enabled: false }) => {
      if (state.phone) {
        state.phone = {
          ...state.phone,
          extra: {
            ...state.phone.extra,
            enabled: choice.enabled,
            monthlyLimitCents: choice.enabled ? (choice.monthlyLimitUsd == null ? null : choice.monthlyLimitUsd * 100) : state.phone.extra.monthlyLimitCents,
            // Turning it on shows what some extra use looks like ("$0.30" at 2.5¢ a minute).
            usedMinutes: choice.enabled ? 12 : 0,
            usedCents: choice.enabled ? 30 : 0,
          },
        };
      }
      for (const listener of statusListeners) listener();
      return state;
    },
    openCheckout: async (plan?: string, cleanup?: { push: boolean; instanceIds: string[] }) => {
      console.info(`[browser mock] cloud.openCheckout ${plan ?? "plus"}`, cleanup ?? "");
      // A paid account changes plan without a checkout page, as the server does: Pro to Plus waits for the period's end.
      if (fix.planId === "free") {
        // The checkout page "comes back" a moment later: the plan lands with a fresh period.
        const landed = (plan ?? "plus") as Fixture["planId"];
        window.setTimeout(() => {
          fix.planId = landed;
          fix.freshPeriod = true;
          fix.usedMilli = 0;
          state = account(fix, machines, Date.now());
          for (const listener of statusListeners) listener();
        }, 1_500);
        return { opened: true };
      }
      if (!plan) return { opened: true };
      const downgrade = plan === "plus" && fix.planId === "pro";
      if (downgrade && cleanup) {
        state.billing = { ...state.billing, nextPlanId: "plus" };
        state.downgradePreviews = {};
        state.planCleanup = { ...mockCleanup(machines, "plus", state.billing.periodEnd), freeing: { ...cleanup, at: Date.now() } };
        for (const listener of statusListeners) listener();
      }
      return { opened: false, change: downgrade ? "next_period" : "now", ...(cleanup ? { freeing: cleanup.instanceIds } : {}) };
    },
    // A lane's status menu: an awake computer with one agent working (`?mockCloudIdle=1`: idle, sleeping soon), with a restart and memory pressure.
    computerStatus: async (instanceId: string) => {
      const box = machines.find((entry) => entry.instanceId === instanceId);
      if (!box) return null;
      const at = Date.now();
      const running = box.state === "running";
      const idle = param("mockCloudIdle") === "1";
      return {
        instanceId,
        status: box.status,
        awakeSince: box.awakeSinceMs ?? null,
        activity: running
          ? idle
            ? { busy: false, idleSince: at - 60_000, sleepsAt: at + 2 * 60_000, runningAgents: 0, reportedAt: at - 60_000 }
            : { busy: true, idleSince: null, sleepsAt: null, runningAgents: 1, reportedAt: at - 5 * 60_000 }
          : null,
        restarts: running ? 1 : null,
        memory: running ? "pressure" as const : null,
        outOfMemory: false,
        disk: { usedBytes: Math.round((box.diskUsage?.totalGb ?? 4) * 0.6 * 1024 ** 3), limitBytes: (box.resources?.diskGb ?? 4) * 1024 ** 3, at },
        readAt: at,
      };
    },
    keepIdleComputer: async (instanceId: string) => {
      console.info("[browser mock] cloud.keepIdleComputer", instanceId);
      state.dueForDeletion = state.dueForDeletion.filter((entry) => entry.instanceId !== instanceId);
      for (const listener of statusListeners) listener();
      return { ok: true };
    },
    pickPlanCleanup: async (input: { planId: string; push: boolean; instanceIds: string[] }) => {
      console.info("[browser mock] cloud.pickPlanCleanup", input);
      if (state.planCleanup) state.planCleanup = { ...state.planCleanup, freeing: { push: input.push, instanceIds: input.instanceIds, at: Date.now() } };
      for (const listener of statusListeners) listener();
      return state;
    },
    openBillingPortal: async () => {
      console.info("[browser mock] cloud.openBillingPortal");
      return { opened: true };
    },
    // A lane move from saved copies (`keptLaneRestore.ts`). `?mockCloudSaved=0`: the
    // asleep computer's save isn't complete; `=refused`: it woke after the preview.
    previewKeptLaneRestore: async (args: CloudKeptLaneRestorePreviewArgs): Promise<CloudKeptLaneRestorePreview> => {
      const saved = savedParam !== "0";
      return {
        laneId: args.laneId,
        laneName: "auth-refresh",
        branchRef: "feature/auth-refresh",
        hasRepository: true,
        work: { unpushedCommits: 2, changedFiles: 3, bytes: 48_000 },
        chats: [
          { chatId: "mock-restore-1", title: "Refresh tokens before they expire", provider: "claude", kind: "chat", history: "full" },
          { chatId: "mock-restore-2", title: "Review the session cookie", provider: "codex", kind: "chat", history: "full" },
          { chatId: "mock-restore-3", title: "Try the redirect on staging", provider: "cursor", kind: "chat", history: "transcript" },
        ],
        ...(args.fromComputer ? {
          fromComputer: {
            saved,
            reason: saved ? null : CLOUD_BACKUP_NOT_SAVED_SENTENCE,
            ignored: { checkedAt: now - 3 * HOUR, paths: [".env", ".env.local", "data/dev.sqlite"], more: 0, rebuildable: 2 },
          },
        } : {}),
      };
    },
    restoreKeptLane: async (args: CloudKeptLaneRestoreArgs): Promise<CloudKeptLaneRestoreRecord> => {
      const at = new Date().toISOString();
      const record: CloudKeptLaneRestoreRecord = {
        restoreId: `mock-restore-${Date.now()}`,
        laneId: args.laneId,
        laneName: "auth-refresh",
        state: "running",
        localLaneId: null,
        step: args.fromComputer ? "release" : "lane",
        chats: [],
        error: null,
        startedAt: at,
        updatedAt: at,
      };
      mockRestores.set(record.restoreId, { record, startedAt: Date.now(), refused: savedParam === "refused" });
      return record;
    },
    // Each step takes 2 s: release, lane, then one chat at a time.
    getKeptLaneRestore: async (args: { restoreId: string }): Promise<CloudKeptLaneRestoreRecord | null> => {
      const entry = mockRestores.get(args.restoreId);
      if (!entry) return null;
      const ticks = Math.floor((Date.now() - entry.startedAt) / 2_000);
      const base = { ...entry.record, updatedAt: new Date().toISOString() };
      if (entry.record.step === "release" && entry.refused && ticks >= 1) {
        return { ...base, state: "failed", wakeInstead: true, error: "The ADE Cloud computer is awake, so its saved copy may be older than its work." };
      }
      const steps = entry.record.step === "release" ? ticks - 1 : ticks;
      if (steps < 0) return base;
      if (steps === 0) return { ...base, step: "lane" };
      const titles = ["Refresh tokens before they expire", "Review the session cookie", "Try the redirect on staging"];
      const chats = titles.map((title, index) => ({
        chatId: `mock-restore-${index + 1}`,
        title,
        state: index < steps - 1 ? "restored" as const : "pending" as const,
        history: index < steps - 1 ? (index === 2 ? "transcript" as const : "full" as const) : null,
        error: null,
      }));
      const done = steps - 1 >= titles.length;
      return { ...base, localLaneId: "lane-auth-here", step: done ? "done" : "chats", state: done ? "completed" : "running", chats };
    },
    openFreeUnlock: async () => {
      console.info("[browser mock] cloud.openFreeUnlock");
      return { opened: true, unlocked: false };
    },
    // `idle`: saved chats of computers ADE deleted, so Work and the chat show
    // a deleted computer's lane (one kept by the server, one not).
    ...(scenario === "idle" ? {
      savedChats: mockDeletedComputerChats(now),
      // The account's queue: a message to a deleted computer's chat makes a new one.
      sendChatMessage: async (args: { messageId: string }) => {
        console.info(`[browser mock] cloud.sendChatMessage ${JSON.stringify(args)}`);
        return { state: "sent", messageId: args.messageId, wake: { state: "launching", launchId: null } };
      },
    } : {}),
    laneLife: async ({ method }: { method: string }) => {
      if (method === "lanesWithoutComputer") return without;
      if (method === "listJobs") return [];
      if (method === "workState") return { unpushed: false, checked: true };
      console.info(`[browser mock] cloud.laneLife ${method}`);
      return { ok: true, message: "Done in the preview." };
    },
    onLaneJob: () => () => undefined,
    laneBackups: async (laneId?: string | null) => backups.filter((entry) => !laneId || entry.laneId === laneId),
    saveLaneBackupPatch: async (_machineKey: string, laneId: string) => {
      console.info("[browser mock] cloud.saveLaneBackupPatch", laneId);
      return { savedTo: `${laneId}-saved-work.patch` };
    },
    forgetLaneBackup: async (machineKey: string, laneId: string) => {
      backups = backups.filter((entry) => !(entry.machineKey === machineKey && entry.laneId === laneId));
      return { deleted: 1 };
    },
    clearCaches: async () => ({ freedGb: 1.2 }),
    // The CTO's home on ADE Cloud, as the desktop makes it (`ctoCloudHomeService.ts`).
    // `?mockCtoCloud=fail` fails the clone step, so Retry and Cancel can be seen.
    ...mockCtoCloudHome(fix.planId !== "free", param("mockCtoCloud") === "fail"),
    redeemInvite: async (code: string) => {
      console.info(`[browser mock] cloud.redeemInvite (${code.length} chars)`);
      if (!code.trim().toUpperCase().includes("FRIEND")) return { ok: false, reason: "unknown_code", message: "That invite code doesn't exist. Check it and try again." };
      return { ok: true, rewarded: false, referral: (state as { referral?: unknown }).referral ?? null };
    },
  };
  ade.cloudAccess = {
    read: async () => ({ enabled: accessOn, signInEnd: null }),
    onChanged: () => () => undefined,
  };
}

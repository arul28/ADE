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
  type CloudMachine,
  type CloudMachinesResult,
  type CloudPlanCleanup,
} from "../shared/adeCloud";
import type { CloudLaneMachine, CloudLaneWithoutComputer } from "../shared/cloudLaneLaunch";

type Scenario = "free" | "empty" | "plus" | "pro" | "downgrade" | "over" | "full" | "blocked";
const SCENARIOS: readonly Scenario[] = ["free", "empty", "plus", "pro", "downgrade", "over", "full", "blocked"];
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
    free: { includedMilli: 50_000, computerLimit: 3, diskGb: 12, priceUsd: 0 },
    paid: { includedMilli: 500_000, computerLimit: 10, diskGb: 40, priceUsd: 5 },
    plus: { includedMilli: 500_000, computerLimit: 10, diskGb: 40, priceUsd: 5 },
    pro: { includedMilli: 1_500_000, computerLimit: 30, diskGb: 120, priceUsd: 20 },
  },
  diskStepGb: 4,
  paidPriceUsd: 5,
  extraHourCents: 1,
  extraDiskCentsPer10GbMonth: 100,
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
    lane: spec.lane ? { laneId: `lane-${spec.id}`, laneName: spec.lane, projectOrigin: "github.com/acme/web" } : null,
  };
}

const round = (gb: number) => Math.round(gb * 10) / 10;

type Fixture = {
  planId: "free" | "plus" | "pro";
  usedMilli: number;
  lanes: LaneSpec[];
  without: Array<{ name: string; reason: "freed" | "inactive" | "plan_limit" }>;
  extraHours?: boolean;
  earnedMilli?: number;
  blocked?: boolean;
  recentUsedMilli?: number;
  /** Pro with a move to Plus waiting, over Plus's limits: the cleanup notice and "Stay on Pro". */
  downgrade?: boolean;
  /** The plan in force is over its limits: new computers refused until the person picks. */
  over?: boolean;
};

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
          { id: "m2q8w1b2", lane: "android-push", tier: "large", diskGb: 16, state: "asleep", lastActiveAgoMs: 5 * HOUR, createdAgoMs: 9 * DAY, unpushed: true },
          { id: "p7r4t5c3", lane: "fix-login-redirect", tier: "small", diskGb: 4, state: "asleep", lastActiveAgoMs: 2 * DAY, createdAgoMs: 4 * DAY, pr: "merged" },
          { id: "z1x2c3d4", lane: "search-index", tier: "small", diskGb: 4, state: "running", lastActiveAgoMs: 0, createdAgoMs: DAY },
          { id: "q9w8e7f5", lane: "docs-pass", tier: "small", diskGb: 4, state: "asleep", lastActiveAgoMs: 19 * DAY, createdAgoMs: 30 * DAY, pr: "merged" },
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
          diskGb: [12, 28, 4, 8, 4, 16, 44, 24, 4, 8, 4][index]!,
          state: index % 3 === 0 ? "running" : "asleep",
          lastActiveAgoMs: index % 3 === 0 ? 0 : (index + 1) * 7 * HOUR,
          createdAgoMs: (index + 2) * DAY,
          pr: index % 4 === 0 ? "merged" : "open",
        })),
        without: [],
      };
    case "downgrade":
      return { ...fixture("pro"), downgrade: true };
    case "over":
      return { ...fixture("plus"), planId: "free", usedMilli: 9_000, extraHours: false, earnedMilli: undefined, over: true };
    case "full":
      return {
        planId: "free",
        usedMilli: 50_000,
        recentUsedMilli: 9_000,
        lanes: [
          { id: "f1u2l3l4", lane: "monorepo-upgrade", tier: "small", diskGb: 8, state: "asleep", lastActiveAgoMs: 4 * HOUR, createdAgoMs: 12 * DAY, unpushed: true },
          { id: "f5u6l7l8", lane: "flaky-tests", tier: "small", diskGb: 3, state: "asleep", lastActiveAgoMs: 16 * DAY, createdAgoMs: 20 * DAY, pr: "merged" },
        ],
        without: [],
      };
    case "blocked":
      return { planId: "free", usedMilli: 0, lanes: [], without: [], blocked: true };
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
  const period = periodBounds(now);
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
    rules: fix.planId === "free" ? "free" : "paid",
    planId: fix.planId,
    hours: {
      includedMilli,
      usedMilli: used,
      leftMilli: left,
      percentUsed: percent,
      state: left <= 0 ? "zero" : percent >= 95 ? "warn95" : percent >= 80 ? "warn80" : "none",
    },
    extraHours: { available: fix.planId !== "free", enabled: fix.extraHours === true, usedMilli: fix.planId === "pro" ? 4_200 : 0 },
    extraDisk: fix.planId === "free" ? undefined : { available: true, state: "off", monthlyLimitCents: null, usedCents: 0 },
    disk: { usedGb: fix.planId === "free" && fix.lanes.length === 2 && fix.usedMilli === 50_000 ? 11 : diskUsed, limitGb: plan.diskGb },
    computers: {
      total: machines.length,
      awake: machines.filter((box) => box.state === "running").length,
      limit: plan.computerLimit,
    },
    recentUse: fix.recentUsedMilli ? { days: 7, usedMilli: fix.recentUsedMilli } : undefined,
    dueForDeletion: [],
    deletedInstanceIds: [],
    catalog: CATALOG,
    billing: {
      periodStart: period.start,
      periodEnd: period.end,
      stripeStatus: fix.planId === "free" ? null : "active",
      cancelAtPeriodEnd: false,
      nextPlanId: fix.downgrade ? "plus" : null,
      notice: null,
    },
    ...(fix.downgrade ? { planCleanup: mockCleanup(machines, "plus", period.end) } : {}),
    ...(fix.over ? { planCleanup: mockCleanup(machines, "free", null) } : {}),
    ...(fix.planId === "pro" && !fix.downgrade ? { downgradePreviews: { plus: mockCleanup(machines, "plus", period.end), free: mockCleanup(machines, "free", period.end) } } : {}),
    ...extra,
  } as CloudAccountState;
}

/** What goes over `planId` (oldest first), as the server's `planCleanupFor` says it. */
function mockCleanup(machines: CloudLaneMachine[], planId: "free" | "plus", startsAt: number | null): CloudPlanCleanup {
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
  let count = machines.length;
  let disk = usedGb;
  for (const choice of choices) {
    if (count <= plan.computerLimit && disk <= plan.diskGb) break;
    computers.push(choice);
    count -= 1;
    disk -= choice.diskGb;
  }
  const facts = { planId, usedGb, limitGb: plan.diskGb, computerCount: machines.length, computerLimit: plan.computerLimit };
  return { ...facts, computers, choices, startsAt, freeing: null, sentence: planCleanupSentence(facts) };
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
  const now = Date.now();
  const fix = fixture(scenario);
  const machines = fix.lanes.map((spec) => machine(spec, now));
  const state = account(fix, machines, now);
  const without: CloudLaneWithoutComputer[] = fix.without.map((lane, index) => ({
    laneId: `lane-without-${index}`,
    laneName: lane.name,
    reason: lane.reason,
    type: "default",
    cpu: 2,
    memoryGb: 4,
    projectOrigin: "github.com/acme/web",
    freedAt: now - 3 * DAY,
  }) as unknown as CloudLaneWithoutComputer);
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
    openCheckout: async (plan?: string, cleanup?: { push: boolean; instanceIds: string[] }) => {
      console.info(`[browser mock] cloud.openCheckout ${plan ?? "plus"}`, cleanup ?? "");
      // A paid account changes plan without a checkout page, as the server does: Pro to Plus waits for the period's end.
      if (fix.planId === "free" || !plan) return { opened: true };
      const downgrade = plan === "plus" && fix.planId === "pro";
      if (downgrade && cleanup) {
        state.billing = { ...state.billing, nextPlanId: "plus" };
        state.downgradePreviews = {};
        state.planCleanup = { ...mockCleanup(machines, "plus", state.billing.periodEnd), freeing: { ...cleanup, at: Date.now() } };
        for (const listener of statusListeners) listener();
      }
      return { opened: false, change: downgrade ? "next_period" : "now", ...(cleanup ? { freeing: cleanup.instanceIds } : {}) };
    },
    pickPlanCleanup: async (input: { planId: "free" | "plus"; push: boolean; instanceIds: string[] }) => {
      console.info("[browser mock] cloud.pickPlanCleanup", input);
      if (state.planCleanup) state.planCleanup = { ...state.planCleanup, freeing: { push: input.push, instanceIds: input.instanceIds, at: Date.now() } };
      for (const listener of statusListeners) listener();
      return state;
    },
    openBillingPortal: async () => {
      console.info("[browser mock] cloud.openBillingPortal");
      return { opened: true };
    },
    openFreeUnlock: async () => {
      console.info("[browser mock] cloud.openFreeUnlock");
      return { opened: true, unlocked: false };
    },
    laneLife: async ({ method }: { method: string }) => {
      if (method === "lanesWithoutComputer") return without;
      if (method === "listJobs") return [];
      if (method === "workState") return { unpushed: false, checked: true };
      console.info(`[browser mock] cloud.laneLife ${method}`);
      return { ok: true, message: "Done in the preview." };
    },
    onLaneJob: () => () => undefined,
    clearCaches: async () => ({ freedGb: 1.2 }),
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

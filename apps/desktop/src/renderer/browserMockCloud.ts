/**
 * Browser preview of the ADE Cloud dashboard: an account, its lane computers
 * and lanes kept without one. Fake data only (no real ids, emails or keys).
 *
 * `?mockCloud=<scenario>` turns it on. Without the flag nothing here runs.
 *  - `free` (default): Free plan, one lane (1 of its 2 computers).
 *  - `empty`: Free plan, nothing made yet.
 *  - `plus`: Plus plan at all 3 of its computers, extra credits on, earned credits.
 *  - `pro`: Pro plan, a busy account over Plus's computers ("Move to Plus" asks first).
 *  - `downgrade`: Pro with a move to Plus waiting (made in the billing portal), over Plus.
 *  - `over`: Free plan in force, over its limits (a cancel made in the billing portal).
 *  - `full`: Free plan out of hours (bigger computers stop; Small keeps working).
 *  - `blocked`: Free plan refused on this computer (another account used it).
 *  - `idle`: Free plan, one lane unused 2 days (deleted in 1 day, ignored files listed) and one whose computer the idle cleanup removed,
 *    with its saved work; Settings › ADE Cloud also lists saved work from a deleted project's lane.
 *  - `idlepaid`: Plus, one lane unused 7 days (deleted in 3 days, no ignored-files summary yet).
 *  - `idleheld`: Free plan, one lane ADE didn't delete because it couldn't save its work (over 50 MB).
 *  - `pastdue`: Plus with its last payment failed (free plan rules until it's paid).
 *  - `limit`: Free plan using both its computers (one has no lane): a new lane opens the computer limit card.
 *  - `upgraded`: Plus a moment after checkout, with this computer last seeing Free
 *    (79.1 free hours left): the "You're on Plus" confirmation shows once.
 *  - `emptyplus`: Plus with nothing made yet and no use this period.
 * On `free`, Get Plus lands the plan a moment later, as a checkout coming back does.
 * `&mockCloudAccess=off` answers "no ADE Cloud" (the hidden state); `&mockCloudUnread=1` answers
 * the plan with the computer list unread (the web app's failed `GET /cloud/instances`).
 * Every account answers in credits (one balance the iPhone draws from too);
 * `&mockPhone=on` gives a Free account the ADE Cloud iPhone; and
 * `&mockPhoneProvider=auto|nomac|revyl` makes the account a tester with that pick.
 * `&mockMac=1` offers the DAEX Cloud Mac (`catalog.mac`) and adds a Mac lane in
 * each state (waiting, starting, on, stopping, stopped, a failed start, a lost
 * drive); `&mockMac=offer` offers it with no Mac lane yet; `&mockMac=broke` offers it at zero credits.
 * `&mockMacLane=running|queued|starting|stopped` (with `mockCloudLaneMachine=1`) makes the chat's
 * lane computer (checkout-redesign) a Mac in that state. With `&mockPricing=`, the Mac carries its
 * ad price too and each Mac its price row.
 *
 * It runs after the sign-ins preview (`?mockSignIns=`), keeping its sign-in
 * calls and replacing only the account and computer reads.
 */
import { BRAND } from "../shared/brand";
import {
  CLOUD_MACHINE_DEFAULT_NAME,
  cloudFreeGithubSentence,
  cloudFreePlanRefusedSentence,
  formatCloudFreeGithubDay,
  type CloudFreeModelsLock,
  type CloudFreePlanGithubState,
  planCleanupSentence,
  type CloudAccountState,
  type CloudIgnoredFiles,
  type CloudMachine,
  type CloudMachinesResult,
  type CloudPlanCleanup,
  type CloudSponsoredChoice,
  type CloudSponsoredConsent,
} from "../shared/adeCloud";
import { ADE_FREE_MODELS } from "../shared/adeFreeModels";
import { githubRepoOf, type CloudLaneMachine, type CloudLaneWithoutComputer } from "../shared/cloudLaneLaunch";
import {
  CLOUD_MAC_SHAPE,
  CLOUD_MAC_START_FAILED_SENTENCES,
  CLOUD_MAC_STATE_SENTENCES,
  CLOUD_MAC_UNSUPPORTED,
  type CloudMacOffer,
  type CloudMacStartFailure,
  type CloudMacStateName,
} from "../../../account-directory/src/cloud/contract";
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
  type CloudAdsState,
  type CloudComputerPrice,
  type CloudFullPriceReason,
  type CloudLaneBackup,
  type CloudLaneBackupFacts,
} from "../../../account-directory/src/cloud/contract";
import { cloudCatalog, nextPlanOffer } from "../../../account-directory/src/cloud/plans";

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

type Scenario = "free" | "empty" | "plus" | "pro" | "max" | "downgrade" | "over" | "full" | "blocked" | "idle" | "idlepaid" | "idleheld" | "pastdue" | "limit" | "upgraded" | "emptyplus";
const SCENARIOS: readonly Scenario[] = ["free", "empty", "plus", "pro", "max", "downgrade", "over", "full", "blocked", "idle", "idlepaid", "idleheld", "pastdue", "limit", "upgraded", "emptyplus"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The first URL's query: the app routes away from it and drops the query.
const INITIAL_SEARCH = typeof window === "undefined" ? "" : window.location.search;

function param(name: string): string | null {
  try {
    return new URLSearchParams(INITIAL_SEARCH).get(name);
  } catch {
    return null;
  }
}

/** The server's own catalog (Pricing v2 numbers), with every plan offered. */
const CATALOG: CloudAccountState["catalog"] = cloudCatalog({ pro: true, max: true });

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
  small: { type: "box", cpu: 2, memoryGb: 4, shapeId: "2x4" },
  medium: { type: "box", cpu: 4, memoryGb: 8, shapeId: "4x8" },
  large: { type: "vm", cpu: 4, memoryGb: 8, shapeId: "4x8" },
  xlarge: { type: "vm", cpu: 4, memoryGb: 16, shapeId: "4x16" },
} as const;

/** A size's Medium-hours an hour, from the catalog (Small never uses hours). */
function rateOf(tier: LaneSpec["tier"]): number {
  return (CATALOG.sizes.find((size) => size.tier === tier)?.multiplierMilli ?? 0) / 1000;
}

/**
 * The lane a mock computer holds. checkout-redesign is the lane
 * `?mockCloudLaneMachine=1` pairs (`browserMock.ts`). `?mockCloudChatLane=awake`
 * (or `asleep`) puts the demo's selected chat lane (`lane-auth`) on an awake (or
 * asleep) computer, so its chat header shows the cloud button and its menu;
 * `idle` puts it on the `idle`/`idleheld` scenarios' computer the idle cleanup
 * warned about, so the chat shows its "deleting soon" band.
 */
function mockLaneIdOf(spec: LaneSpec): string {
  const chatLane = param("mockCloudChatLane");
  if ((chatLane === "awake" && spec.id === "k3j9x0a1") || (chatLane === "asleep" && spec.id === "m2q8w1b2") || (chatLane === "idle" && spec.id === "i9d1l2e3")) return "lane-auth";
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
    name: spec.lane ? `${BRAND.NAME} · ${spec.lane}` : CLOUD_MACHINE_DEFAULT_NAME,
    status: spec.state === "running" ? "running" : spec.state === "asleep" ? "sleeping" : spec.state,
    state: spec.state,
    type: shape.type,
    resources: { cpu: shape.cpu, memoryGb: shape.memoryGb, diskGb: spec.diskGb },
    shapeId: shape.shapeId,
    region: "us-east",
    hoursRate: rateOf(spec.tier),
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

/** The DAEX Cloud Mac offer as the server sends it (`CloudMacOffer`), at Pricing v2's scale. */
const MOCK_MAC_OFFER: CloudMacOffer = {
  label: "Mac",
  ...CLOUD_MAC_SHAPE,
  creditMilliPerMinute: 500,
  stopAfterIdleMinutes: 5,
  startSeconds: { min: 20, max: 45 },
  summary: "A macOS computer for Xcode and the iOS Simulator.",
  keeps: "A Mac stops 5 minutes after work ends. Only its 20 GB drive is kept; anything outside it is gone.",
};

/** One Mac lane per state, for `&mockMac=1`. */
function mockMacMachines(now: number): CloudLaneMachine[] {
  const specs: Array<{ id: string; lane: string; state: CloudMacStateName; status: string; failure?: CloudMacStartFailure; usedGb: number | null; agoMs: number }> = [
    { id: "mac-q1", lane: "ios-onboarding", state: "queued", status: "starting", usedGb: 7.4, agoMs: 2 * 60_000 },
    { id: "mac-s1", lane: "widget-extension", state: "starting", status: "starting", usedGb: 3.1, agoMs: 20_000 },
    { id: "mac-r1", lane: "swiftui-previews", state: "running", status: "running", usedGb: 9.8, agoMs: 12 * 60_000 },
    { id: "mac-x1", lane: "watch-app", state: "stopping", status: "stopped", usedGb: 5.2, agoMs: 60_000 },
    { id: "mac-z1", lane: "app-store-shots", state: "stopped", status: "stopped", usedGb: 7.4, agoMs: 3 * HOUR },
    { id: "mac-f1", lane: "testflight-fix", state: "stopped", status: "stopped", failure: "queue_expired", usedGb: 4.0, agoMs: 70 * 60_000 },
    { id: "mac-l1", lane: "old-mac-lane", state: "stopped", status: "stopped", failure: "drive_lost", usedGb: null, agoMs: 2 * DAY },
  ];
  return specs.map((spec) => asMockMac(
    machine({ id: spec.id, lane: spec.lane, tier: "medium", diskGb: 20, state: spec.status === "running" ? "running" : spec.status === "starting" ? "starting" : "stopped", lastActiveAgoMs: spec.agoMs, createdAgoMs: 4 * DAY }, now),
    spec,
    now,
  ));
}

/** A mock computer as a DAEX Cloud Mac in one state (`mac` as the server sends it). */
function asMockMac(
  base: CloudLaneMachine,
  spec: { state: CloudMacStateName; status: string; failure?: CloudMacStartFailure; usedGb: number | null; agoMs: number },
  now: number,
): CloudLaneMachine {
  return {
    ...base,
    status: spec.status,
    type: "box",
    resources: { cpu: CLOUD_MAC_SHAPE.cpu, memoryGb: CLOUD_MAC_SHAPE.memoryGb, diskGb: CLOUD_MAC_SHAPE.driveGb },
    shapeId: null,
    hoursRate: null,
    diskUsage: null,
    awakeSinceMs: spec.state === "running" ? now - spec.agoMs : null,
    os: "mac",
    unsupported: [...CLOUD_MAC_UNSUPPORTED],
    mac: {
      state: spec.state,
      since: now - spec.agoMs,
      message: spec.failure ? CLOUD_MAC_START_FAILED_SENTENCES[spec.failure] : CLOUD_MAC_STATE_SENTENCES[spec.state],
      ...(spec.failure ? { startFailed: true, failure: spec.failure } : {}),
      drive: { sizeGb: CLOUD_MAC_SHAPE.driveGb, usedGb: spec.usedGb, savedAt: spec.usedGb == null ? null : now - spec.agoMs },
    },
  };
}

type Fixture = {
  planId: "free" | "plus" | "pro" | "max";
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
            row.error = `The new computer can't read this repository. Check that ${BRAND.CLOUD_NAME} can sign in to GitHub for it, then retry.`;
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
        if (!paid) throw new Error(`${BRAND.CLOUD_NAME} as the CTO's home needs a paid plan. Upgrade to use it.`);
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
        usedMilli: 72_400,
        extraHours: true,
        earnedMilli: 40_000,
        recentUsedMilli: 61_000,
        lanes: [
          { id: "k3j9x0a1", lane: "checkout-redesign", tier: "medium", diskGb: 8, state: "running", lastActiveAgoMs: 0, createdAgoMs: 6 * DAY, pr: "open" },
          { id: "m2q8w1b2", lane: "android-push", tier: "large", diskGb: 10, state: "asleep", lastActiveAgoMs: 5 * HOUR, createdAgoMs: 9 * DAY, unpushed: true },
          { id: "p7r4t5c3", lane: "fix-login-redirect", tier: "small", diskGb: 4, state: "asleep", lastActiveAgoMs: 7 * DAY, createdAgoMs: 12 * DAY, pr: "merged" },
        ],
        without: [{ name: "billing-webhooks", reason: "freed" }],
      };
    case "pro":
      return {
        planId: "pro",
        usedMilli: 410_000,
        recentUsedMilli: 140_000,
        extraHours: true,
        lanes: Array.from({ length: 9 }, (_, index): LaneSpec => ({
          id: `pro${index}x7k2`,
          lane: ["api-gateway", "ios-onboarding", "perf-sweep", "e2e-flake", "design-tokens", "billing-v2", "android-emu", "ml-ranker", "docs-site"][index]!,
          tier: (["medium", "large", "small", "small", "small", "medium", "xlarge", "large", "small"] as const)[index]!,
          diskGb: [8, 12, 4, 4, 4, 8, 10, 6, 2][index]!,
          state: index % 3 === 0 ? "running" : "asleep",
          lastActiveAgoMs: index % 3 === 0 ? 0 : (index + 1) * 7 * HOUR,
          createdAgoMs: (index + 2) * DAY,
          pr: index % 4 === 0 ? "merged" : "open",
        })),
        without: [],
      };
    case "max":
      return { ...fixture("pro"), planId: "max", usedMilli: 1_210_000 };
    case "downgrade":
      return { ...fixture("pro"), downgrade: true };
    case "pastdue":
      return { ...fixture("plus"), pastDue: true, extraHours: false };
    case "limit":
      return {
        planId: "free",
        usedMilli: 6_200,
        recentUsedMilli: 1_900,
        lanes: [
          { id: "a7c2e9k4", lane: "fix-login-redirect", tier: "small", diskGb: 4, state: "running", lastActiveAgoMs: 0, createdAgoMs: 2 * DAY, pr: "open" },
          { id: "7z5o5rwcau", lane: null, tier: "medium", diskGb: 4, state: "asleep", lastActiveAgoMs: 12 * DAY, createdAgoMs: 14 * DAY },
        ],
        without: [],
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
        idle: [{ id: "p7r4t5c3", inMs: 3 * DAY - HOUR, days: 10, ignored: null }],
      };
    default:
      return {
        planId: "free",
        usedMilli: 6_200,
        recentUsedMilli: 1_900,
        lanes: [
          { id: "a7c2e9k4", lane: "fix-login-redirect", tier: "small", diskGb: 4, state: "running", lastActiveAgoMs: 0, createdAgoMs: 2 * DAY, pr: "open" },
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

/** `?mockFreeModels=locked-*|checking`: ADE Free Models under the GitHub rule, with the server's sentences. */
function mockFreeModelsLock(kind: string | null, now: number): CloudFreeModelsLock | null {
  const at = now + 19 * DAY;
  if (kind === "locked-too-new" || kind === "locked-on") {
    return { reason: "too_new", oldEnoughAt: at, githubLogin: "octo-new", canUnlockWithCard: true, sentence: `Your GitHub account is new, so ${BRAND.NAME} Free Models unlock on ${formatCloudFreeGithubDay(at)}. Add a card (no charge) to unlock them now.` };
  }
  if (kind === "locked-no-github") {
    return { reason: "no_github", oldEnoughAt: null, githubLogin: null, canUnlockWithCard: true, sentence: `${BRAND.NAME} Free Models need a GitHub account at least 30 days old, or a payment card. Connect GitHub, or add a card (no charge) to unlock them.` };
  }
  if (kind === "locked-used") {
    return { reason: "used", oldEnoughAt: null, githubLogin: "octo-shared", canUnlockWithCard: true, sentence: `This GitHub account already unlocked ${BRAND.NAME} Free Models on another ${BRAND.NAME} account. Add a card (no charge) to unlock them here.` };
  }
  if (kind === "checking") {
    return { reason: "checking", oldEnoughAt: null, githubLogin: null, canUnlockWithCard: false, sentence: `Checking your GitHub account… ${BRAND.NAME} Free Models unlock once that's done.` };
  }
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
      state: left <= 0 && !fix.extraHours && (fix.earnedMilli ?? 0) <= 0 ? "zero" : percent >= 95 ? "warn95" : percent >= 80 ? "warn80" : "none",
    },
    extraHours: { available: fix.planId !== "free", enabled: fix.extraHours === true, usedMilli: fix.planId === "pro" ? 4_200 : 0 },
    phone: fix.planId === "free" ? undefined : { access: "on" },
    // No account disk; the plan limits computers, asleep or not, and the server names the next plan up.
    disk: { usedGb: diskUsed, limitGb: null },
    computers: {
      total: machines.length,
      awake: machines.filter((box) => box.state === "running").length,
      limit: plan.computerLimit ?? 0,
      nextPlan: nextPlanOffer(fix.planId, { pro: true, max: true }),
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

/** What goes over `planId`'s computers (oldest first), as the server's `planCleanupFor` says it. */
function mockCleanup(machines: CloudLaneMachine[], planId: "free" | "plus" | "pro", startsAt: number | null): CloudPlanCleanup {
  const plan = CATALOG.plans[planId]!;
  const computerLimit = plan.computerLimit ?? machines.length;
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
  const computers = choices.slice(0, Math.max(0, choices.length - computerLimit));
  const facts = { planId, usedGb, limitGb: usedGb, computerCount: choices.length, computerLimit };
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
  const phoneParam = param("mockPhone") === "on";
  const providerParam = param("mockPhoneProvider");
  const scenario: Scenario = SCENARIOS.includes(requested) ? requested : "free";
  const accessOn = param("mockCloudAccess") !== "off";
  // Read once: the app routes away from the first URL and drops its query.
  const savedParam = param("mockCloudSaved");
  const now = Date.now();
  const macParam = param("mockMac");
  // `&mockMac=broke`: the Mac offered, no credits left and no extra credits (the pick's zero-credit notice).
  const fix = macParam === "broke"
    ? { ...fixture(scenario), usedMilli: 1_000_000_000, extraHours: false, earnedMilli: undefined }
    : fixture(scenario);
  // `&mockMacLane=running|queued|starting|stopped`: the computer of the `mockCloudLaneMachine=1` chat (checkout-redesign) is a Mac.
  const macLaneParam = param("mockMacLane") as CloudMacStateName | null;
  const macLaneState = macLaneParam && macLaneParam in CLOUD_MAC_STATE_SENTENCES ? macLaneParam : null;
  const machines = fix.lanes.map((spec) => {
    const box = machine(spec, now);
    if (!macLaneState || spec.lane !== "checkout-redesign") return box;
    const status = macLaneState === "running" ? "running" : macLaneState === "queued" || macLaneState === "starting" ? "starting" : "stopped";
    return asMockMac({ ...box, state: status === "running" ? "running" : status === "starting" ? "starting" : "stopped" }, { state: macLaneState, status, usedGb: 7.4, agoMs: 3 * 60_000 }, now);
  });
  if (macParam === "1") machines.push(...mockMacMachines(now));
  let state = account(fix, machines, now);
  if (macParam === "1" || macParam === "offer" || macParam === "broke" || macLaneState) state = { ...state, catalog: { ...state.catalog, mac: MOCK_MAC_OFFER } };
  // Credits: the iPhone has used some of the balance.
  const withCredits = (next: CloudAccountState): CloudAccountState => {
    let out = next;
    if (phoneParam && !out.phone) out = { ...out, phone: { access: "on" } };
    if (out.phone && (providerParam === "auto" || providerParam === "nomac" || providerParam === "revyl")) {
      out = { ...out, phone: { ...out.phone, providerChoice: providerParam } };
    }
    const phoneUsed = out.phone ? Math.min(out.hours.usedMilli, Math.round(out.hours.usedMilli * 0.4)) : 0;
    return {
      ...out,
      credits: { phoneMilliPerMinute: 1000 },
      phone: out.phone ? { ...out.phone, creditsUsedMilli: phoneUsed } : undefined,
    };
  };
  state = withCredits(state);
  // `&mockSponsored=ask` (the one-time question), `on` (answered yes) or `small` (below): sponsored
  // cards, test ads only, whatever the scenario's plan (the server says when).
  // Pair with `mockCloudLaneMachine=1` so a chat runs on an ADE Cloud computer.
  const sponsoredParam = param("mockSponsored");
  // `pick`: answered yes, for the Index pick card demo.
  if (sponsoredParam === "ask" || sponsoredParam === "on" || sponsoredParam === "pick") {
    state = { ...state, sponsored: { ads: true, consent: sponsoredParam === "ask" ? null : "granted", test: true } };
  }
  // `small`: ads reach this Free account and it has no answer yet, so
  // Small uses hours (half a Medium-hour an hour) until the person says yes.
  const smallRate = (consent: CloudSponsoredConsent | null) => ({
    ...state.catalog,
    sizes: state.catalog.sizes.map((size) => size.tier === "small" ? { ...size, multiplierMilli: consent === "granted" ? 0 : 500 } : size),
  });
  if (sponsoredParam === "small") {
    state = { ...state, sponsored: { ads: true, consent: null, test: true, smallNeedsCards: true }, catalog: smallRate(null) };
  }
  // `starts-on`: as `small`, from a country where cards start on (the US): the notice, not the question.
  if (sponsoredParam === "starts-on") {
    state = { ...state, sponsored: { ads: true, consent: null, test: true, smallNeedsCards: true, startsOn: true }, catalog: smallRate(null) };
  }
  // `again`: as `small`, asked again after a no: a yes is confirmed a second time.
  if (sponsoredParam === "again") {
    state = { ...state, sponsored: { ads: true, consent: null, test: true, smallNeedsCards: true, confirmYes: true }, catalog: smallRate(null) };
  }
  // `lapsed`: a yes, but no cloud chat opened from the US in 7 days: Small uses credits until the next one.
  if (sponsoredParam === "lapsed") {
    state = { ...state, sponsored: { ads: true, consent: "granted", test: true, smallNeedsCards: true, smallNeedsLook: true }, catalog: smallRate("declined") };
  }
  // `abroad`: a yes, read from Canada (cards show, but free Small is for the US only): Small uses credits.
  if (sponsoredParam === "abroad") {
    state = { ...state, sponsored: { ads: true, consent: "granted", test: true, smallOutsideUS: true }, catalog: smallRate("declined") };
  }
  // `gpc`: a browser's Global Privacy Control turned an earlier yes off: Settings says why.
  if (sponsoredParam === "gpc") {
    state = { ...state, sponsored: { ads: true, consent: "declined", test: true, smallNeedsCards: true, confirmYes: true, gpcOff: true }, catalog: smallRate("declined") };
  }
  // `&mockSponsoredFormat=below_reply|above_prompt|inline`: where the card shows (the server's `format`).
  const formatParam = param("mockSponsoredFormat");
  if (state.sponsored && (formatParam === "below_reply" || formatParam === "above_prompt" || formatParam === "inline")) {
    state = { ...state, sponsored: { ...state.sponsored, format: formatParam } };
  }
  // Pricing v3 (`&mockPricing=`): `on` / `off` (the notice answered, ads on or off), `notice` (a region
  // where ads start on, notice not seen), `ask` (a region that asks first, not seen), `none` (no ads in
  // this country), `zero` (a discount of 0, ads on). `&mockPriceReasons=1|2` gives the awake computers each
  // full-price reason in turn.
  const pricingParam = param("mockPricing");
  const pricingKinds = ["on", "off", "notice", "ask", "none", "zero"] as const;
  type PricingKind = (typeof pricingKinds)[number];
  const pricingKind = (pricingKinds as readonly string[]).includes(pricingParam ?? "") ? pricingParam as PricingKind : null;
  // `1`: the ad price, a CLI session, no chat in use; `2`: an automation, an outside agent, unverified.
  const reasonsPage = Number(param("mockPriceReasons") ?? 0);
  const reasonsParam = reasonsPage === 1 || reasonsPage === 2;
  const specByInstance = new Map(fix.lanes.map((spec, index) => [machines[index]!.instanceId, spec]));
  /** The account's prices now, as the server works them out, for the ads state it holds. */
  const pricedState = (next: CloudAccountState, ads: CloudAdsState): CloudAccountState => {
    const catalog = next.catalog;
    const reasons: Array<CloudFullPriceReason | null> = [null, "cli_session", "not_in_use", "automation", "outside_agent", "unverified"];
    let awakeIndex = reasonsPage === 2 ? 3 : 0;
    const computers: CloudComputerPrice[] = machines.map((box) => {
      const size = catalog.sizes.find((entry) => entry.tier === specByInstance.get(box.instanceId)?.tier);
      // A Mac's row carries its minute rate an hour (times 60), as the server sends it.
      const macRate = box.os === "mac" ? catalog.mac ?? null : null;
      const full = macRate ? macRate.creditMilliPerMinute * 60 : size?.multiplierMilli ?? 0;
      const ad = macRate ? (macRate.adCreditMilliPerMinute ?? macRate.creditMilliPerMinute) * 60 : size?.adMultiplierMilli ?? full;
      const awake = box.state === "running";
      const picked = awake && reasonsParam ? reasons[awakeIndex++ % reasons.length]! : null;
      const reason: CloudFullPriceReason | null = !ads.available ? "no_ads_here" : !ads.on ? "ads_off" : !awake ? "not_in_use" : picked;
      const now = reason == null ? "ad" as const : "full" as const;
      return { instanceId: box.instanceId, now, reason, adUntil: now === "ad" ? Date.now() + 40 * 60_000 : null, rateMilli: now === "ad" ? ad : full, otherRateMilli: now === "ad" ? full : ad };
    });
    // The server's iPhone rate under Pricing v3 (5 credits a minute).
    return { ...next, credits: { phoneMilliPerMinute: catalog.phone?.milliPerMinute ?? 500 }, pricing: { creditScale: catalog.creditScale ?? 10, ads, computers, phone: null } };
  };
  if (pricingKind) {
    const discountPct = pricingKind === "zero" ? 0 : 20;
    const free = state.plan === "free";
    const available = pricingKind !== "none";
    const noticeSeen = pricingKind === "on" || pricingKind === "off" || pricingKind === "zero";
    const on = available && (pricingKind === "on" || pricingKind === "zero");
    const v3 = cloudCatalog({ pro: true, max: true }, state.planId ?? "free", { v3: { discountPct, smallFullMilli: free ? 500 : 0, freeSmallMilli: 500 } });
    // A Mac offered before keeps its offer, now with its ad price (the server's `adCreditMilliPerMinute`).
    const mac = state.catalog.mac;
    const catalog = mac ? { ...v3, mac: { ...mac, adCreditMilliPerMinute: Math.round((mac.creditMilliPerMinute * (100 - discountPct)) / 100) } } : v3;
    state = {
      ...state,
      catalog,
      // The server answers the old sponsored state too; the ad request follows it.
      sponsored: { ads: true, consent: on ? "granted" : noticeSeen ? "declined" : null, test: true, format: state.sponsored?.format ?? "below_reply" },
    };
    state = pricedState(state, { available, on, startsOn: pricingKind !== "ask", noticeSeen, discountPct, windowMinutes: 60 });
  }
  // `&mockFreeModels=ask|on|declined|abroad`: ADE Free Models for this account, test ads only, on any
  // plan. `ask` opens the one-time sheet on the first pick; `abroad` lists them as unavailable (country).
  // `locked-too-new|locked-no-github|locked-used|checking`: the GitHub rule locks them (not yet asked);
  // "Add a card" unlocks them 6 s later, as a card saved in the browser would. `slowed|paused`: on,
  // with the no-cards throttle (`locked-on` is locked after an earlier yes).
  const freeModelsParam = param("mockFreeModels");
  const freeLock = mockFreeModelsLock(freeModelsParam, now);
  const freeThrottle = freeModelsParam === "slowed" || freeModelsParam === "paused" ? freeModelsParam : null;
  if (freeModelsParam === "ask" || freeModelsParam === "on" || freeModelsParam === "declined" || freeModelsParam === "abroad" || freeLock || freeThrottle) {
    const granted = freeModelsParam === "on" || freeModelsParam === "locked-on" || freeThrottle != null;
    state = {
      ...state,
      freeModels: {
        modelIds: ADE_FREE_MODELS.map((model) => model.id),
        available: freeModelsParam !== "abroad",
        ...(freeModelsParam === "abroad" ? { reason: "country" as const } : {}),
        consent: granted ? "granted" : freeModelsParam === "declined" ? "declined" : null,
        format: state.sponsored?.format ?? "below_reply",
        test: true,
        ...(freeLock ? { locked: freeLock } : {}),
        ...(freeThrottle ? { throttle: freeThrottle } : {}),
      },
    };
  }
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
  // `&mockCloudUnread=1`: the web app's computer list failed (`computersUnread`), the plan still read.
  const unread = param("mockCloudUnread") === "1";
  const result = (): CloudMachinesResult => ({
    state: "ok",
    machines: unread ? [] : machines,
    ...(unread ? { computersUnread: true } : {}),
    instanceCount: machines.length,
    runningCount: machines.filter((box) => box.state === "running").length,
    account: state,
    deletedInstanceIds: [],
    message: null,
  });
  // `&mockCloudLatency=400`: each account read answers after this many ms, as the account server does (load timing).
  const latency = Math.max(0, Number(param("mockCloudLatency")) || 0);
  const lag = () => (latency ? new Promise<void>((resolve) => window.setTimeout(resolve, latency)) : Promise.resolve());
  const base = ade.cloud ?? {};
  ade.cloud = {
    ...base,
    getStatus: async () => {
      await lag();
      return { connected: true, signedOut: false, instanceCount: machines.length, runningCount: result().runningCount, error: null };
    },
    listMachines: async () => {
      await lag();
      return result();
    },
    onStatusChanged: (cb: () => void) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    getAgentLimits: base.getAgentLimits ?? (async () => ({ maxShape: "4x8", machinesPerDay: 3, unattendedHours: true, askBeforeVm: true })),
    setAgentLimits: base.setAgentLimits ?? (async (limits: unknown) => limits),
    setSponsoredConsent: async (choice: CloudSponsoredChoice, confirmed?: boolean, noticeSeen?: boolean) => {
      if (!state.sponsored) return null;
      // Pricing v3: the switch and the notice's answers move the account's ads, and every price with them.
      if (state.pricing) {
        const ads = state.pricing.ads;
        // As the server (US rules): after a no, a yes needs the second confirm (409 `sponsored_confirm`).
        if (choice === "granted" && state.sponsored.confirmYes && !confirmed) {
          throw new Error("Turning ads back on takes a second confirm. Try again.");
        }
        const on = ads.available && (choice === "granted" || choice === "notice");
        const { confirmYes: _wasConfirmYes, ...rest } = state.sponsored;
        state = pricedState(
          { ...state, sponsored: { ...rest, consent: on ? "granted" : "declined", ...(on ? {} : { confirmYes: true }) } },
          { ...ads, on, noticeSeen: ads.noticeSeen || noticeSeen === true },
        );
        for (const listener of statusListeners) listener();
        return state.sponsored ?? null;
      }
      // As the server: after a no, a yes needs the second confirm.
      if (choice === "granted" && state.sponsored.confirmYes && !confirmed) {
        throw new Error(`Turning sponsored cards back on takes a second confirm. Try again, or update ${BRAND.NAME} if it doesn't ask.`);
      }
      // A notice is a yes where cards start on; the account state stops saying `startsOn` once answered.
      const consent: CloudSponsoredConsent = choice === "notice" ? "granted" : choice;
      const { startsOn: _startsOn, confirmYes: _confirmYes, gpcOff: _gpcOff, smallNeedsLook: _smallNeedsLook, ...sponsored } = state.sponsored;
      // After a no, a yes is confirmed a second time, as the server has it.
      state = { ...state, sponsored: { ...sponsored, consent, ...(consent === "declined" ? { confirmYes: true } : {}) } };
      if (state.sponsored?.smallNeedsCards) state = { ...state, catalog: smallRate(consent) };
      for (const listener of statusListeners) listener();
      return state.sponsored ?? null;
    },
    sponsoredSeen: async () => undefined,
    setFreeModelsConsent: async (consent: CloudSponsoredConsent) => {
      if (!state.freeModels) return null;
      state = { ...state, freeModels: { ...state.freeModels, consent } };
      for (const listener of statusListeners) listener();
      return state.freeModels ?? null;
    },
    freeModelsSeen: async () => true,
    sponsoredHide: async () => undefined,
    sponsoredViewed: async () => true,
    sponsoredAd: async (input?: { instanceId: string | null }) => {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      // An ADE Free Models chat (no computer) shows cards on the free-models answer.
      const consented = input?.instanceId === null ? state.freeModels?.consent === "granted" : state.sponsored?.consent === "granted";
      if (!consented) return { ad: null, reason: "consent" as const };
      return {
        ad: {
          id: "mock-ad-1",
          brand: "Northwind Postgres",
          title: "Managed Postgres with branching",
          text: "Spin up a database branch for every pull request, then merge the schema when it lands.",
          cta: "Learn more",
          clickUrl: "https://trygravity.ai/",
          impUrl: null,
          favicon: null,
          test: true,
          gravity: MOCK_GRAVITY_AD,
        },
      };
    },
    // A tester's provider pick (`mockPhoneProvider`); anyone else gets the server's refusal.
    setPhoneProvider: async (provider: "auto" | "nomac" | "revyl") => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      if (!state.phone?.providerChoice) throw new Error("This account can't pick who runs its cloud iPhones.");
      state = { ...state, phone: { ...state.phone, providerChoice: provider } };
      for (const listener of statusListeners) listener();
      return { ok: true as const, provider };
    },
    setExtraHours: async (enabled: boolean) => {
      state.extraHours = { ...state.extraHours, enabled };
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
          state = withCredits(account(fix, machines, Date.now()));
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
        return { ...base, state: "failed", wakeInstead: true, error: `The ${BRAND.CLOUD_NAME} computer is awake, so its saved copy may be older than its work.` };
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
      // As a card saved in the browser: the account reads unlocked a few seconds later.
      window.setTimeout(() => {
        if (state.freeModels?.locked) {
          const { locked: _locked, ...freeModels } = state.freeModels;
          state = { ...state, freeModels };
        }
        const freePlan = state.freePlan;
        if (freePlan?.github && freePlan.github.state !== "ok" && freePlan.github.canUnlockWithCard) {
          state = {
            ...state,
            freePlan: { ...freePlan, github: { state: "ok", oldEnoughAt: null, canUnlockWithCard: false, githubLogin: null, sentence: null } },
            hours: { ...state.hours, includedMilli: CATALOG.plans.free!.includedMilli, leftMilli: CATALOG.plans.free!.includedMilli, percentUsed: 0, state: "none" },
          };
        }
        for (const listener of statusListeners) listener();
      }, 6_000);
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
    answerTierRequest: async () => ({ answered: true, toldAgent: true }),
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

/**
 * Gravity's ad for its web renderer, as the account server passes it on: the
 * same design Gravity sends for every ADE placement ("design", 2026-11-25),
 * and an inlined icon. The links are Gravity's hosts; the mock fires nothing.
 */
const MOCK_GRAVITY_AD = {
  adText: "Spin up a database branch for every pull request, then merge the schema when it lands.",
  title: "Managed Postgres with branching",
  cta: "Learn more",
  brandName: "Northwind Postgres",
  url: "https://trygravity.ai/",
  favicon: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f6f5e"/><path d="M10 23V9h2.6l6.8 9.4V9H22v14h-2.6l-6.8-9.4V23z" fill="#fff"/></svg>')}`,
  clickUrl: "https://trygravity.ai/",
  render: { mode: "spec" as const },
  renderer_spec: {
    name: "design",
    version: 1,
    root: {
      bind: "url",
      type: "link",
      style: { gap: "8px", color: "hsl(var(--foreground))", width: "100%", border: "1px solid hsl(var(--border))", display: "flex", padding: "12px 14px", background: "hsl(var(--card))", borderRadius: "var(--radius)", flexDirection: "column", textDecoration: "none" },
      children: [
        {
          type: "box",
          style: { gap: "7px", width: "100%", display: "flex", alignItems: "center" },
          children: [
            { bind: "favicon", type: "image", style: { width: "18px", height: "18px", objectFit: "cover", borderRadius: "4px" } },
            { bind: "brandName", type: "text", style: { color: "hsl(var(--muted-foreground))", fontSize: "12px", fontWeight: 600, lineHeight: 1.2 } },
            { type: "box", style: { flexGrow: 1 } },
            { text: "Sponsored", type: "text", style: { color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))", padding: "2px 6px", fontSize: "10px", fontWeight: 700, lineHeight: 1.2, borderRadius: "999px", letterSpacing: "0.08em", textTransform: "uppercase" } },
          ],
        },
        {
          type: "box",
          style: { gap: "12px", width: "100%", display: "flex", alignItems: "center" },
          children: [
            {
              type: "box",
              style: { gap: "4px", display: "flex", flexGrow: 1, flexDirection: "column" },
              children: [
                { bind: "title", type: "text", style: { color: "hsl(var(--foreground))", fontSize: "15px", fontWeight: 700, lineHeight: 1.3 } },
                { bind: "adText", type: "text", style: { color: "hsl(var(--muted-foreground))", fontSize: "13px", fontWeight: 400, lineHeight: 1.35 }, showIf: "adText" },
              ],
            },
            { bind: "cta", type: "text", style: { color: "hsl(var(--primary-foreground))", padding: "7px 13px", fontSize: "12px", background: "hsl(var(--primary))", flexShrink: 0, fontWeight: 700, lineHeight: 1.2, borderRadius: "999px" } },
          ],
        },
      ],
    },
  },
};

/**
 * The browser preview's ADE Cloud sign-ins: the account's sign-ins, two cloud
 * computers (`cloud-a`, `cloud-b`) and what they applied, for Settings ›
 * Providers on ADE Cloud. Fake data only: no real token, email or key.
 *
 * `?mockSignIns=<scenario>` turns it on. Without the flag nothing here runs
 * and every other preview is unchanged.
 *  - `on` (default): sign-ins from Mac Studio and MacBook, both cloud
 *    computers awake (T3–T7, T9, T11, T12, F2, F3, C8).
 *  - `none`: no cloud computer yet (F4).
 *  - `asleep`: cloud computers exist, none is awake (F5).
 *  - `noanswer`: cloud-a never answers; the page says so after 8 s (F5).
 *  - `off`: sign-ins are off for ADE Cloud (T1).
 *  - `unreadable`: the ADE account can't be read (T2).
 *  - `one`: only cloud-a, so the page shows no computer name.
 *  - `copilot-fallback`: Copilot is not carried (its fallback rows).
 *  - `elsewhere`: both cloud computers are awake, but neither has this
 *    project's repo, so the page can't reach one from here.
 *  - Claude passes: `ending`, `estimate`, `ended` (C3 / C4 / C5, P6–P8),
 *    `upload` (C9, P14, P15), `limits` (P11–P13), `nopass` (C1).
 *
 * `&mockApprove=<end>` decides how a Claude pass approve ends: `match`
 * (default), `unchecked`, `mismatch`, `saved_here` or `failed`. The approve
 * runs on timers in the preview only (no real sign-in): the page link, then
 * the code box, then the check.
 *
 * On a cloud computer's own page (picked as a machine), its Claude accounts
 * include one pass account per pass (`pass-<id>`).
 *
 * `&mockGhCli=<state>` stages Mac Studio's GitHub CLI login for Copilot:
 * `on` (default: in the account, in use), `off`, `classic` (a classic
 * token), `timeout` (gh did not answer) or `absent` (gh not signed in).
 * `&mockGhCliOn=<end>` decides how a press on ON ends: `ok` (default),
 * `classic` or `timeout`, after a 2.5 s wait (the keychain prompt).
 *
 * `&mockSignInRow=<row>` stages one row: T1–T12 on the Grok tile, F1–F5 on
 * the Muse tile (T1, T2, F4 and F5 switch the scenario they need).
 *
 * The writes change the in-memory state and fire `providerLogins.onChanged`,
 * so the switch, Turn on, Allow on this Mac, Use on ADE Cloud, Remove and
 * the saved key can be pressed. Each write logs one `[browser mock]` line.
 *
 * The Grok sign-in from MacBook was last renewed by cloud-a, which renews it
 * while MacBook is off (the takeover).
 */
import type { ClaudePassUseView, CloudClaudeSignInState, CloudSignInEnd, CloudSignInId, CloudSignInStatus } from "../shared/cloudSignIns";
import type {
  ProviderLoginApplied,
  ProviderLoginProvider,
  ProviderLoginProviderStatus,
  ProviderLoginSignIn,
  ProviderLoginStatus,
} from "../shared/types/providerLogins";
import { claudePassAccountId } from "../shared/types/providerLogins";

type Scenario =
  | "on" | "none" | "asleep" | "noanswer" | "off" | "unreadable" | "one" | "copilot-fallback" | "elsewhere"
  | "ending" | "estimate" | "ended" | "upload" | "limits" | "nopass";

const SCENARIOS: readonly Scenario[] = [
  "on", "none", "asleep", "noanswer", "off", "unreadable", "one", "copilot-fallback", "elsewhere",
  "ending", "estimate", "ended", "upload", "limits", "nopass",
];

type GhCliMode = "on" | "off" | "classic" | "timeout" | "absent";
const GH_CLI_MODES: readonly GhCliMode[] = ["on", "off", "classic", "timeout", "absent"];
const GH_TIMEOUT_TEXT = "The GitHub CLI did not answer in time. If your computer asked to unlock its keychain, allow it, then turn this on again.";
const GH_KEY = "copilot/mac-studio.gh";

type ApproveEnd = "match" | "unchecked" | "mismatch" | "saved_here" | "failed";
const APPROVE_ENDS: readonly ApproveEnd[] = ["match", "unchecked", "mismatch", "saved_here", "failed"];

function param(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const MAC_STUDIO = { label: "Mac Studio", platform: "darwin", thisComputer: true };
const MACBOOK = { label: "MacBook", platform: "darwin", thisComputer: false };

const CLOUD_COMPUTERS = [
  { id: "mock-cloud-a", name: "cloud-a", instanceId: "i-mock-cloud-a", machineKey: "mk_cloud_a" },
  { id: "mock-cloud-b", name: "cloud-b", instanceId: "i-mock-cloud-b", machineKey: "mk_cloud_b" },
] as const;

/** The project every machine of the preview has, so the cloud computers are routable. */
const MOCK_REPO = { rootPath: "/home/ade/ADE", displayName: "ADE", gitOriginUrl: "git@github.com:acme-labs/acme-shop.git" };

function signIn(
  provider: ProviderLoginProvider,
  origin: typeof MAC_STUDIO,
  fields: Partial<ProviderLoginSignIn> = {},
): ProviderLoginSignIn {
  const now = Date.now();
  return {
    key: `${provider}/${origin.label.toLowerCase().replace(/\s+/g, "-")}.default`,
    provider,
    slot: "default",
    class: "renewing",
    origin,
    account: null,
    capturedAt: iso(now - 3 * DAY),
    renewedAt: null,
    renewedBy: null,
    expiresAt: null,
    onForCloud: true,
    inUseOnCloud: false,
    ...fields,
  };
}

type MockState = {
  scenario: Scenario;
  row: string | null;
  enabled: boolean;
  signIns: ProviderLoginSignIn[];
  antigravityAllowedAt: string | null;
  /** Mac Studio's GitHub CLI login for Copilot (`allowGitHubCli`). */
  ghCli: GhCliMode;
  saved: Set<CloudSignInId>;
  /** The account's picks (place → key, or "key"), as `cloud.inUse` carries them. */
  inUse: Record<string, string>;
  /** Claude's smart balance on ADE Cloud (`setCloudBalance`), off at the start. */
  smartBalance: boolean;
  passes: MockPass[];
  /** Passes switched off for ADE Cloud. */
  passOff: Set<string>;
  approveEnd: ApproveEnd;
  /** The Claude approve on this computer's service. */
  claude: NonNullable<CloudSignInStatus["claude"]>;
};

type MockPass =
  | { key: string; unreadable: true; createdAt: number }
  | {
    key: string;
    unreadable: false;
    email: string | null;
    check: "match" | "kept_other" | "unchecked";
    madeOnLabel: string | null;
    createdAt: number;
    renewedAt: number | null;
    expiresAt: number;
    expiresAtSource: "estimate" | "claude";
    state: "active" | "ending_soon" | "estimate_passed" | "ended";
    endedAt: number | null;
    upload: "account" | "pending" | "refused";
    /** What a cloud computer saw on the pass's own turns. */
    cloudUse: ClaudePassUseView;
    /** The same Claude account's numbers on one of the person's computers. */
    accountUse: ClaudePassUseView;
  };

const NONE_SEEN: ClaudePassUseView = { state: "none_seen" };

function seenUse(
  kind: "pass_turn" | "account_here",
  label: string | null,
  seenAgoMs: number,
  windows: { fiveHour?: Partial<{ usedPct: number | null; resetsInMs: number; status: "allowed" | "rejected" | null; resetSinceSeen: boolean }>; weekly?: Partial<{ usedPct: number | null; resetsInMs: number; status: "allowed" | "rejected" | null; resetSinceSeen: boolean }> },
): ClaudePassUseView {
  const now = Date.now();
  const seenAt = now - seenAgoMs;
  const from = { kind, label };
  const window = (fields: NonNullable<typeof windows.fiveHour> | undefined, resetsInMs: number) => (fields
    ? {
      usedPct: fields.usedPct === undefined ? null : fields.usedPct,
      resetsAt: now + (fields.resetsInMs ?? resetsInMs),
      status: kind === "pass_turn" ? (fields.status ?? "allowed") : null,
      seenAt,
      resetSinceSeen: fields.resetSinceSeen ?? false,
      from,
    }
    : null);
  return {
    state: "seen",
    lastSeenAt: seenAt,
    fiveHour: window(windows.fiveHour, 2 * HOUR),
    weekly: window(windows.weekly, 4 * DAY),
    models: {},
    from: { ...from, seenAt },
  };
}

function initialPasses(scenario: Scenario, now: number): MockPass[] {
  if (scenario === "nopass") return [];
  const a: Extract<MockPass, { unreadable: false }> = {
    key: "claude-pass/a0a0a0a0a0a1",
    unreadable: false,
    email: "ada@example.com",
    check: "match",
    madeOnLabel: "Mac Studio",
    createdAt: now - 165 * DAY,
    renewedAt: null,
    expiresAt: now + 200 * DAY,
    expiresAtSource: "estimate",
    state: "active",
    endedAt: null,
    upload: "account",
    cloudUse: seenUse("pass_turn", null, 20 * 60_000, { fiveHour: { usedPct: 42 }, weekly: { usedPct: 18 } }),
    accountUse: NONE_SEEN,
  };
  const b: Extract<MockPass, { unreadable: false }> = {
    ...a,
    key: "claude-pass/b0b0b0b0b0b2",
    email: null,
    check: "unchecked",
    createdAt: Date.UTC(new Date(now).getUTCFullYear(), 2, 2),
    expiresAt: now + 110 * DAY,
    cloudUse: NONE_SEEN,
  };
  const d: Extract<MockPass, { unreadable: false }> = {
    ...a,
    key: "claude-pass/d0d0d0d0d0d4",
    email: "ada@home.example",
    madeOnLabel: "MacBook",
    createdAt: now - 40 * DAY,
    renewedAt: now - 3 * DAY,
    expiresAt: now + 362 * DAY,
    cloudUse: NONE_SEEN,
    accountUse: seenUse("account_here", "MacBook", 2 * HOUR, { fiveHour: { usedPct: 12 }, weekly: { usedPct: 61 } }),
  };
  switch (scenario) {
    case "ending":
      Object.assign(a, { state: "ending_soon", expiresAt: now + 5 * DAY });
      break;
    case "estimate":
      Object.assign(a, { state: "estimate_passed", expiresAt: now - 3 * DAY });
      break;
    case "ended":
      for (const pass of [a, b, d]) Object.assign(pass, { state: "ended", endedAt: now - 2 * DAY });
      break;
    case "upload":
      a.upload = "pending";
      d.upload = "refused";
      break;
    case "limits":
      a.cloudUse = seenUse("pass_turn", null, 10 * 60_000, { fiveHour: { usedPct: 100, status: "rejected", resetsInMs: 50 * 60_000 }, weekly: { usedPct: null } });
      d.accountUse = seenUse("account_here", "MacBook", 6 * HOUR, { fiveHour: { usedPct: 30 }, weekly: { usedPct: 70, resetSinceSeen: true } });
      break;
    default:
      break;
  }
  return [d, a, b, { key: "claude-pass/c0c0c0c0c0c3", unreadable: true, createdAt: 0 }];
}

function endsInDays(expiresAt: number): number {
  return Math.max(0, Math.round((expiresAt - Date.now()) / DAY));
}

const IDLE_CLAUDE: NonNullable<CloudSignInStatus["claude"]> = {
  state: "cancelled",
  url: null,
  awaitingCode: false,
  message: null,
  forEmail: null,
  foundEmail: null,
  check: null,
  renewKey: null,
  savedKey: null,
  upload: null,
};

function initialState(): MockState {
  const requested = param("mockSignIns") as Scenario | null;
  const row = param("mockSignInRow")?.toUpperCase() ?? null;
  let scenario: Scenario = requested && SCENARIOS.includes(requested) ? requested : "on";
  if (row === "T1") scenario = "off";
  if (row === "T2") scenario = "unreadable";
  if (row === "F4") scenario = "none";
  if (row === "F5") scenario = "asleep";
  const now = Date.now();
  const signIns: ProviderLoginSignIn[] = [
    signIn("grok", MAC_STUDIO, {
      account: { email: "ada@example.com", id: null },
      renewedAt: iso(now - 2 * HOUR),
      renewedBy: "Mac Studio",
      inUseOnCloud: true,
    }),
    signIn("grok", MACBOOK, {
      capturedAt: iso(now - 7 * DAY),
      renewedAt: iso(now - 5 * 60_000),
      renewedBy: "cloud-a",
      renewedByCloud: true,
      renewsNow: { label: "cloud-a", cloudComputer: true, thisComputer: false },
    }),
    signIn("cursor", MACBOOK, { class: "fixed", expiresAt: iso(now + 2 * DAY), inUseOnCloud: true }),
    signIn("droid", MAC_STUDIO, { onForCloud: false }),
    signIn("codex", MAC_STUDIO, { account: { email: "ada@example.com", id: null } }),
    signIn("kimi", MACBOOK, { inUseOnCloud: true }),
    signIn("devin", MACBOOK, { inUseOnCloud: true }),
    signIn("qwen", MACBOOK, { inUseOnCloud: true }),
    signIn("qwen", MAC_STUDIO),
    signIn("copilot", MAC_STUDIO, { slot: "gh", key: GH_KEY, class: "fixed", account: { email: null, id: "ada-gh" }, inUseOnCloud: true }),
    // Pi: one sign-in per sub-provider; its Claude sign-in never shows.
    signIn("pi", MACBOOK, { slot: "xai", key: "pi/macbook.xai", inUseOnCloud: true }),
    signIn("pi", MAC_STUDIO, { slot: "openai", key: "pi/mac-studio.openai", class: "fixed", inUseOnCloud: true }),
    signIn("pi", MAC_STUDIO, { slot: "anthropic", key: "pi/mac-studio.anthropic", onForCloud: false }),
  ];
  const saved = new Set<CloudSignInId>(["codex", "openrouter"]);
  const approve = param("mockApprove") as ApproveEnd | null;
  const state: MockState = {
    scenario,
    row,
    enabled: scenario !== "off",
    signIns,
    antigravityAllowedAt: null,
    ghCli: GH_CLI_MODES.includes(param("mockGhCli") as GhCliMode) ? param("mockGhCli") as GhCliMode : "on",
    saved,
    inUse: scenario === "nopass" ? { codex: "key" } : { codex: "key", claude: "claude-pass/a0a0a0a0a0a1" },
    smartBalance: false,
    passes: initialPasses(scenario, now),
    passOff: new Set(),
    approveEnd: approve && APPROVE_ENDS.includes(approve) ? approve : "match",
    claude: { ...IDLE_CLAUDE },
  };
  if (state.ghCli !== "on") state.signIns = state.signIns.filter((entry) => entry.key !== GH_KEY);
  applyGrokRow(state, now);
  if (row === "F3") saved.add("muse");
  return state;
}

/** `mockSignInRow=T3…T12`: the Grok tile shows that row. */
function applyGrokRow(state: MockState, now: number): void {
  const grok = state.signIns.filter((entry) => entry.provider === "grok");
  const [studio, macbook] = grok;
  if (!studio || !macbook) return;
  switch (state.row) {
    case "T4":
      studio.inUseOnCloud = false;
      macbook.inUseOnCloud = true;
      break;
    case "T9":
      for (const entry of grok) {
        entry.onForCloud = false;
        entry.inUseOnCloud = false;
      }
      break;
    case "T10":
    case "T11":
      state.signIns = state.signIns.filter((entry) => entry.provider !== "grok");
      break;
    case "T12":
      studio.expiresAt = iso(now + 2 * DAY);
      break;
    case "T6":
      // The account picks the saved xAI key over both sign-ins.
      state.saved.add("grok");
      state.inUse.grok = "key";
      studio.inUseOnCloud = false;
      break;
    default:
      break;
  }
}

/** Copilot's row on Mac Studio (its own computer): the GitHub CLI login and what it means for the local state. */
function copilotGhFields(state: MockState): Partial<ProviderLoginProviderStatus> {
  const mode = state.ghCli;
  const allowed = mode === "on" || mode === "classic" || mode === "timeout";
  return {
    local: {
      state: mode === "on" ? "captured" : mode === "timeout" ? "unreadable" : mode === "absent" ? "not_signed_in" : "not_checked",
      key: mode === "on" ? GH_KEY : null,
    },
    ghCli: {
      present: mode !== "absent",
      user: mode === "absent" ? null : "ada-gh",
      allowed,
      canAllow: true,
      ...(mode === "classic" ? { unsupported: "classic_token" as const } : {}),
      ...(mode === "timeout" ? { lastError: GH_TIMEOUT_TEXT } : {}),
      ...(allowed ? { lastReadAt: iso(Date.now() - 60_000) } : {}),
    },
  };
}

function providerRows(state: MockState, own = true): ProviderLoginProviderStatus[] {
  const carry = (provider: ProviderLoginProvider): ProviderLoginProviderStatus["carry"] => {
    if (provider === "claude") return "never";
    if (provider === "opencode" || provider === "muse") return "fallback";
    if (provider === "copilot" && state.scenario === "copilot-fallback") return "fallback";
    return "carried";
  };
  const providers: ProviderLoginProvider[] = [
    "claude", "codex", "cursor", "opencode", "pi", "copilot", "grok", "droid", "kimi", "qwen", "devin", "antigravity", "muse",
  ];
  return providers.map((provider) => ({
    provider,
    carry: carry(provider),
    message: "",
    local: {
      state: state.signIns.some((entry) => entry.provider === provider && entry.origin.thisComputer) ? "captured" : "not_signed_in",
      key: state.signIns.find((entry) => entry.provider === provider && entry.origin.thisComputer)?.key ?? null,
    },
    ...(provider === "antigravity"
      ? {
        keychain: {
          canAllow: true,
          allowedAt: state.antigravityAllowedAt,
          message: state.antigravityAllowedAt ? "Copied from this Mac. Allow again to update." : "On this Mac it is in the Keychain.",
        },
      }
      : {}),
    ...(provider === "copilot" && own ? copilotGhFields(state) : {}),
  }));
}

type MockPasses = NonNullable<ProviderLoginStatus["claudePasses"]>;

/** The pass new chats use: the account's pick, else the newest one on that has not ended. */
function newChatsKey(state: MockState): string | null {
  const readable = state.passes.filter((pass): pass is Extract<MockPass, { unreadable: false }> => !pass.unreadable);
  const usable = readable.filter((pass) => state.enabled && !state.passOff.has(pass.key) && pass.state !== "ended");
  const picked = state.inUse.claude;
  if (picked && usable.some((pass) => pass.key === picked)) return picked;
  return usable[0]?.key ?? null;
}

/** `claudePasses` as a brain sends it: `withUse` on a cloud computer (the pass's own turns). */
function claudePasses(state: MockState, withUse: boolean): MockPasses {
  const current = newChatsKey(state);
  return state.passes.map((pass) => {
    if (pass.unreadable) return { key: pass.key, unreadable: true as const };
    return {
      key: pass.key,
      unreadable: false as const,
      label: pass.email ?? "Claude pass",
      email: pass.email,
      check: pass.check,
      legacy: false,
      on: state.enabled && !state.passOff.has(pass.key),
      newChats: pass.key === current,
      madeOnLabel: pass.madeOnLabel,
      createdAt: pass.createdAt,
      renewedAt: pass.renewedAt,
      expiresAt: pass.expiresAt,
      expiresAtSource: pass.expiresAtSource,
      endsInDays: endsInDays(pass.expiresAt),
      state: pass.state,
      noticeDueAt: pass.expiresAt - 14 * DAY,
      upload: pass.upload,
      localInstanceId: null,
      appliedHere: withUse,
      homeHasLogin: false,
      smartBalance: state.smartBalance,
      endedAt: pass.endedAt,
      use: withUse ? pass.cloudUse : NONE_SEEN,
    };
  });
}

/** `cloudSignInStatus().passes`: the account side, with the same account's numbers on a computer. */
function accountPasses(state: MockState): NonNullable<CloudSignInStatus["passes"]> {
  return state.passes.map((pass) => {
    if (pass.unreadable) return { key: pass.key, unreadable: true as const };
    return {
      key: pass.key,
      label: pass.email ?? "Claude pass",
      email: pass.email,
      check: pass.check,
      legacy: false,
      madeOnLabel: pass.madeOnLabel,
      createdAt: pass.createdAt,
      renewedAt: pass.renewedAt,
      expiresAt: pass.expiresAt,
      expiresAtSource: pass.expiresAtSource,
      endsInDays: endsInDays(pass.expiresAt),
      state: pass.state,
      endedAt: pass.endedAt,
      noticeDueAt: pass.expiresAt - 14 * DAY,
      localInstanceId: null,
      use: pass.accountUse,
      upload: pass.upload,
      unreadable: false as const,
    };
  });
}

function accountStatus(state: MockState): ProviderLoginStatus {
  if (state.scenario === "unreadable") {
    return {
      thisComputer: { capture: "off", reason: "vault_unavailable", message: "ADE couldn't read your ADE account.", label: "Mac Studio", cloudComputer: false, lastPassAt: null },
      cloud: { enabled: true, inUse: {}, claude: { smartBalance: false } },
      signIns: [],
      providers: providerRows(state),
      applied: null,
      claudePasses: [],
    };
  }
  return {
    thisComputer: {
      capture: state.enabled ? "on" : "off",
      reason: state.enabled ? null : "all_off",
      message: null,
      label: "Mac Studio",
      cloudComputer: false,
      lastPassAt: iso(Date.now() - 4 * 60_000),
    },
    cloud: { enabled: state.enabled, inUse: { ...state.inUse }, claude: { smartBalance: state.smartBalance } },
    signIns: state.signIns.map((entry) => ({ ...entry })),
    providers: providerRows(state),
    applied: null,
    claudePasses: claudePasses(state, false),
  };
}

function appliedRows(state: MockState): ProviderLoginApplied[] {
  const now = Date.now();
  const keyOf = (provider: ProviderLoginProvider, origin = MAC_STUDIO) =>
    state.signIns.find((entry) => entry.provider === provider && entry.origin.label === origin.label)?.key ?? null;
  const row = (provider: ProviderLoginProvider, fields: Partial<ProviderLoginApplied>): ProviderLoginApplied => ({
    place: provider,
    provider,
    state: "applied",
    key: null,
    accessOnly: true,
    renewalSafe: true,
    appliedAt: iso(now - 30 * 60_000),
    message: "",
    ownerOff: null,
    ...fields,
  });
  const grok = (): ProviderLoginApplied => {
    switch (state.row) {
      case "T4": return row("grok", { key: keyOf("grok") });
      case "T5": return row("grok", { state: "own", key: null });
      case "T6": return row("grok", { state: "key", key: "key" });
      case "T7": return row("grok", { state: "failed", key: null, message: "The disk is full." });
      case "T8": return row("grok", { key: keyOf("grok"), ownerOff: { ownerLabel: "Mac Studio", at: iso(now - 10 * 60_000) } });
      case "T9": return row("grok", { state: "none", key: null });
      case "T10":
      case "T11": return row("grok", { state: "none", key: null });
      case "T12": return row("grok", { key: keyOf("grok"), renewalSafe: false });
      default: return row("grok", { key: keyOf("grok") });
    }
  };
  if (!state.enabled) return [];
  return [
    grok(),
    row("codex", { state: "key", key: "key" }),
    row("cursor", { key: keyOf("cursor", MACBOOK) }),
    row("droid", { state: "none" }),
    row("kimi", { state: "own" }),
    row("devin", { state: "failed", message: "The disk is full." }),
    row("qwen", { key: keyOf("qwen", MAC_STUDIO) }),
    row("copilot", { key: keyOf("copilot") }),
  ];
}

function cloudStatus(state: MockState, name: string): ProviderLoginStatus {
  return {
    thisComputer: { capture: "off", reason: "not_this_runtime", message: null, label: name, cloudComputer: true, lastPassAt: iso(Date.now() - 60_000) },
    cloud: { enabled: state.enabled, inUse: { ...state.inUse }, claude: { smartBalance: state.smartBalance } },
    signIns: state.signIns.map((entry) => ({ ...entry, origin: { ...entry.origin, thisComputer: false } })),
    providers: providerRows(state, false),
    applied: appliedRows(state),
    claudePasses: claudePasses(state, true),
  };
}

function awakeComputers(state: MockState) {
  if (state.scenario === "none" || state.scenario === "asleep") return [];
  return state.scenario === "one" ? CLOUD_COMPUTERS.slice(0, 1) : CLOUD_COMPUTERS;
}

function cloudTargetOf(pin: unknown): (typeof CLOUD_COMPUTERS)[number] | null {
  if (!pin || typeof pin !== "object") return null;
  const targetId = (pin as { kind?: string; targetId?: string }).kind === "remote" ? (pin as { targetId?: string }).targetId : null;
  return CLOUD_COMPUTERS.find((computer) => computer.id === targetId) ?? null;
}

function cloudTarget(computer: (typeof CLOUD_COMPUTERS)[number]) {
  return {
    id: computer.id,
    name: computer.name,
    hostname: computer.instanceId,
    transport: "paired" as const,
    pairedMachine: { hostIdentity: `mock-${computer.name}`, machineKey: computer.machineKey },
    sshUser: null,
    port: null,
    sshKeyPath: null,
    lastSeenArch: "linux-x64",
    runtimeBinaryVersion: "0.0.0-browser",
    lastConnectedAt: Date.now(),
  };
}

function cloudConnection(computer: (typeof CLOUD_COMPUTERS)[number], awake: boolean, elsewhere: boolean) {
  return {
    target: cloudTarget(computer),
    state: awake ? "connected" : "idle",
    arch: "linux-x64",
    version: "0.0.0-browser",
    route: awake ? { kind: "relay", endpoint: "relay.ade-app.dev" } : null,
    capabilities: awake ? { projects: true } : null,
    projects: awake && !elsewhere
      ? [{ projectId: `mock-project-${computer.name}`, addedAt: Date.now() - 30 * DAY, lastOpenedAt: Date.now() - HOUR, ...MOCK_REPO }]
      : [],
    lastError: null,
    lastAttemptedAt: Date.now(),
    connectedAt: awake ? Date.now() - HOUR : null,
  };
}

function cloudBox(computer: (typeof CLOUD_COMPUTERS)[number], awake: boolean) {
  return {
    instanceId: computer.instanceId,
    name: computer.name,
    status: awake ? "running" : "suspended",
    state: awake ? "running" : "asleep",
    type: "vm",
    resources: null,
    shapeId: null,
    region: null,
    hoursRate: 1,
    pastDue: false,
    failure: null,
    machineKey: computer.machineKey,
  };
}

/**
 * Adds `providerLogins`, `cloud` and `cloudAccess` to the preview's bridge and
 * the two cloud computers to its connections, when `?mockSignIns` is set.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyBrowserMockProviderLogins(ade: any): void {
  if (param("mockSignIns") == null && param("mockSignInRow") == null) return;
  const state = initialState();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const statusFor = async (pin: unknown): Promise<ProviderLoginStatus> => {
    const computer = cloudTargetOf(pin);
    if (!computer) {
      await wait(150);
      return accountStatus(state);
    }
    // `noanswer`: cloud-a never answers; the page's 8 s limit ends the read.
    if (state.scenario === "noanswer" && computer.id === "mock-cloud-a") return new Promise(() => undefined);
    await wait(700);
    return cloudStatus(state, computer.name);
  };
  /** In use: the switched-on sign-in that was in use, else the first switched on. */
  const settleInUse = (provider: ProviderLoginProvider) => {
    const rows = state.signIns.filter((entry) => entry.provider === provider);
    const current = rows.find((entry) => entry.inUseOnCloud && entry.onForCloud) ?? rows.find((entry) => entry.onForCloud) ?? null;
    for (const entry of rows) entry.inUseOnCloud = entry === current;
  };

  ade.providerLogins = {
    status: (_args: unknown, pin?: unknown) => statusFor(pin),
    captureNow: async (_args: unknown, pin?: unknown) => {
      await wait(800);
      return statusFor(pin);
    },
    allowKeychain: async () => {
      console.info("[browser mock] providerLogins.allowKeychain started");
      // macOS asks first; the preview waits as long as a person reading the prompt.
      await wait(2500);
      state.antigravityAllowedAt = iso(Date.now());
      state.signIns.push(signIn("antigravity", MAC_STUDIO, { slot: "personal", key: "antigravity/mac-studio.personal", inUseOnCloud: true }));
      changed();
      return accountStatus(state);
    },
    allowGitHubCli: async (args: { on: boolean }, pin?: unknown) => {
      console.info(`[browser mock] providerLogins.allowGitHubCli ${args.on ? "on" : "off"}`);
      if (args.on && cloudTargetOf(pin)) {
        throw new Error("Turn this on at that computer. The GitHub CLI can ask there to unlock its keychain, so ADE reads it only on the computer you are using.");
      }
      const dropSignIn = () => {
        state.signIns = state.signIns.filter((entry) => entry.key !== GH_KEY);
        if (state.inUse.copilot === GH_KEY) delete state.inUse.copilot;
        settleInUse("copilot");
      };
      if (!args.on) {
        await wait(300);
        state.ghCli = "off";
        dropSignIn();
      } else {
        // The keychain prompt: the preview waits as long as a person reading it.
        await wait(2500);
        const end = param("mockGhCliOn");
        if (end === "classic" || end === "timeout") {
          state.ghCli = end;
          dropSignIn();
        } else {
          state.ghCli = "on";
          if (!state.signIns.some((entry) => entry.key === GH_KEY)) {
            state.signIns.push(signIn("copilot", MAC_STUDIO, { slot: "gh", key: GH_KEY, class: "fixed", account: { email: null, id: "ada-gh" }, capturedAt: iso(Date.now()) }));
            settleInUse("copilot");
          }
        }
      }
      changed();
      return statusFor(pin);
    },
    use: async (args: { provider: ProviderLoginProvider; key: string | null }) => {
      console.info(`[browser mock] providerLogins.use ${args.provider} ${args.key ?? "newest"}`);
      await wait(300);
      if (args.key) state.inUse[args.provider] = args.key;
      else delete state.inUse[args.provider];
      const picked = args.key && args.key !== "key" ? state.signIns.find((entry) => entry.key === args.key) : null;
      if (picked) picked.onForCloud = true;
      for (const entry of state.signIns) {
        if (entry.provider === args.provider) entry.inUseOnCloud = args.key === "key" ? false : entry.key === args.key;
      }
      if (args.key === null) settleInUse(args.provider);
      changed();
      return accountStatus(state);
    },
    setCloud: async (args: { key: string; on: boolean }) => {
      console.info(`[browser mock] providerLogins.setCloud ${args.key} ${args.on ? "on" : "off"}`);
      await wait(300);
      if (args.key.startsWith("claude-pass/")) {
        if (args.on) state.passOff.delete(args.key);
        else state.passOff.add(args.key);
      }
      const entry = state.signIns.find((candidate) => candidate.key === args.key);
      if (entry) {
        entry.onForCloud = args.on;
        settleInUse(entry.provider);
      }
      changed();
      return accountStatus(state);
    },
    setCloudAll: async (args: { on: boolean }) => {
      await wait(300);
      state.enabled = args.on;
      if (state.scenario === "off") state.scenario = "on";
      changed();
      return accountStatus(state);
    },
    setCloudBalance: async (args: { provider: "claude"; on: boolean }) => {
      console.info(`[browser mock] providerLogins.setCloudBalance ${args.on ? "on" : "off"}`);
      await wait(300);
      state.smartBalance = args.on;
      changed();
      return accountStatus(state);
    },
    remove: async (args: { key: string }) => {
      console.info(`[browser mock] providerLogins.remove ${args.key}`);
      const removed = state.signIns.find((entry) => entry.key === args.key);
      state.signIns = state.signIns.filter((entry) => entry.key !== args.key);
      state.passes = state.passes.filter((pass) => pass.key !== args.key);
      if (removed) settleInUse(removed.provider);
      for (const [place, key] of Object.entries(state.inUse)) {
        if (key === args.key) delete state.inUse[place];
      }
      changed();
      return accountStatus(state);
    },
    onChanged: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  const computersShown = state.scenario === "none" ? [] : state.scenario === "one" ? CLOUD_COMPUTERS.slice(0, 1) : CLOUD_COMPUTERS;
  const awake = new Set<string>(awakeComputers(state).map((computer) => computer.id));
  const savedList = () => (["claude", "codex", "cursor", "droid", "grok", "copilot", "devin", "muse", "openrouter"] as CloudSignInId[])
    .map((id) => ({ id, saved: state.saved.has(id), savedAt: state.saved.has(id) ? Date.now() - 5 * DAY : null }));
  const signInListeners = new Set<() => void>();
  /** What `cloud.cloudSignInStatus` answers: the saved keys, the passes, the approve, and this computer's Claude accounts. */
  const signInStatus = (): CloudSignInStatus => ({
    saved: savedList(),
    unknown: false,
    claude: { ...state.claude },
    localAccounts: [
      { instanceId: "claude", email: "ada@example.com", isDefault: true },
      { instanceId: "claude-2", email: "ada@home.example", isDefault: false },
    ],
    passes: accountPasses(state),
  });
  /** A window's action changed the cloud sign-ins: every window hears it (main sends this after each action). */
  const signInChanged = () => {
    for (const listener of signInListeners) listener();
  };
  // ── The Claude approve, on timers in the preview (no real sign-in) ──
  let approveTimer: ReturnType<typeof setTimeout> | null = null;
  const later = (ms: number, step: () => void) => {
    if (approveTimer) clearTimeout(approveTimer);
    approveTimer = setTimeout(() => {
      approveTimer = null;
      step();
    }, ms);
  };
  const setClaude = (patch: Partial<NonNullable<CloudSignInStatus["claude"]>>) => {
    state.claude = { ...state.claude, ...patch };
  };
  const savePass = (email: string | null, check: "match" | "kept_other" | "unchecked", upload: "account" | "pending") => {
    const now = Date.now();
    const renewKey = state.claude.renewKey;
    const key = renewKey ?? `claude-pass/${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}${Date.now().toString(16).slice(-6)}`;
    const fresh: MockPass = {
      key,
      unreadable: false,
      email,
      check,
      madeOnLabel: "Mac Studio",
      createdAt: renewKey ? (state.passes.find((pass) => pass.key === renewKey)?.createdAt ?? now) : now,
      renewedAt: renewKey ? now : null,
      expiresAt: now + 365 * DAY,
      expiresAtSource: "estimate",
      state: "active",
      endedAt: null,
      upload,
      cloudUse: NONE_SEEN,
      accountUse: NONE_SEEN,
    };
    state.passes = [fresh, ...state.passes.filter((pass) => pass.key !== key)];
    return key;
  };
  const finish = () => {
    const forEmail = state.claude.forEmail;
    switch (state.approveEnd) {
      case "failed":
        setClaude({ state: "failed", message: "Claude Code stopped before it made a pass. Try again." });
        return;
      case "saved_here": {
        const key = savePass(forEmail, "match", "pending");
        setClaude({ state: "saved_here", foundEmail: forEmail, check: "match", savedKey: key, upload: "pending", message: "ADE couldn't reach your account yet. The pass is kept on this computer, and ADE sends it on its own." });
        changed();
        return;
      }
      case "mismatch":
        if (forEmail) {
          setClaude({ state: "mismatch", foundEmail: "someone@else.example", check: null });
          return;
        }
        break;
      default:
        break;
    }
    const unchecked = state.approveEnd === "unchecked";
    const found = unchecked ? null : forEmail ?? "ada@work.example";
    setClaude({ state: "saving", foundEmail: found, check: unchecked ? "unchecked" : "match" });
    later(800, () => {
      const key = savePass(found ?? forEmail, unchecked ? "unchecked" : "match", "account");
      setClaude({ state: "succeeded", savedKey: key, upload: "account" });
      changed();
    });
  };
  ade.cloud = {
    getStatus: async () => ({ connected: true, signedOut: false, instanceCount: computersShown.length, runningCount: awake.size, error: null }),
    listMachines: async () => ({
      state: "ok",
      machines: computersShown.map((computer) => cloudBox(computer, awake.has(computer.id))),
      instanceCount: computersShown.length,
      runningCount: awake.size,
      account: null,
      deleted: [],
    }),
    onStatusChanged: () => () => undefined,
    cloudSignInStatus: async () => signInStatus(),
    onCloudSignInChanged: (cb: () => void) => {
      signInListeners.add(cb);
      return () => signInListeners.delete(cb);
    },
    cloudSignInClaudeStart: async (args?: { forEmail?: string | null; renewKey?: string | null }) => {
      console.info(`[browser mock] cloud.cloudSignInClaudeStart for ${args?.forEmail ?? "another account"}${args?.renewKey ? ` (renew ${args.renewKey})` : ""}`);
      await wait(250);
      state.claude = { ...IDLE_CLAUDE, state: "running" as CloudClaudeSignInState, forEmail: args?.forEmail ?? null, renewKey: args?.renewKey ?? null };
      later(900, () => {
        setClaude({ url: "https://claude.ai/oauth/authorize?code=true&mock=preview" });
        later(1200, () => setClaude({ awaitingCode: true }));
      });
      signInChanged();
      return signInStatus();
    },
    cloudSignInClaudeCode: async () => {
      // The code itself is never kept or logged.
      console.info("[browser mock] cloud.cloudSignInClaudeCode");
      await wait(250);
      setClaude({ state: "verifying", awaitingCode: false });
      later(1500, finish);
      signInChanged();
      return signInStatus();
    },
    cloudSignInClaudeKeep: async () => {
      console.info("[browser mock] cloud.cloudSignInClaudeKeep");
      await wait(250);
      const found = state.claude.foundEmail;
      setClaude({ state: "saving", check: "kept_other" });
      later(800, () => {
        const key = savePass(found, "kept_other", "account");
        setClaude({ state: "succeeded", savedKey: key, upload: "account" });
        changed();
      });
      signInChanged();
      return signInStatus();
    },
    cloudSignInClaudeCancel: async () => {
      console.info("[browser mock] cloud.cloudSignInClaudeCancel");
      if (approveTimer) clearTimeout(approveTimer);
      approveTimer = null;
      setClaude({ state: "cancelled", awaitingCode: false });
      signInChanged();
      return signInStatus();
    },
    cloudSignInSaveKey: async (id: CloudSignInId) => {
      // The key itself is never kept or logged; only that one was saved.
      console.info(`[browser mock] cloud.cloudSignInSaveKey ${id}`);
      await wait(300);
      state.saved.add(id);
      return signInStatus();
    },
    cloudSignInRemove: async (id: CloudSignInId) => {
      console.info(`[browser mock] cloud.cloudSignInRemove ${id}`);
      await wait(300);
      state.saved.delete(id);
      for (const [place, key] of Object.entries(state.inUse)) {
        if (key === "key" && (place === id || (id === "openrouter" && place === "opencode"))) {
          delete state.inUse[place];
          settleInUse(place as ProviderLoginProvider);
        }
      }
      changed();
      return signInStatus();
    },
  };
  /** As desktop main computes it (cloudSignInEndWarning.ts): the soonest due pass, ended first; nothing while off. */
  const signInEnd = (): CloudSignInEnd | null => {
    if (!state.enabled) return null;
    const now = Date.now();
    const due: CloudSignInEnd[] = [];
    for (const pass of state.passes) {
      if (pass.unreadable) continue;
      const passState: CloudSignInEnd["state"] | null = pass.state === "ended"
        ? "ended"
        : pass.state === "estimate_passed" ? "estimate_passed" : pass.expiresAt - 7 * DAY <= now ? "ending" : null;
      if (passState) {
        due.push({ kind: "claude_pass", key: pass.key, state: passState, email: pass.email, expiresAt: pass.expiresAt, endedAt: pass.endedAt, endsInDays: endsInDays(pass.expiresAt), more: 0, fingerprint: "" });
      }
    }
    if (!due.length) return null;
    due.sort((x, y) => ((x.state === "ended") === (y.state === "ended") ? x.expiresAt - y.expiresAt : x.state === "ended" ? -1 : 1));
    return { ...due[0]!, more: due.length - 1, fingerprint: due.map((entry) => `${entry.key}:${entry.state}`).sort().join("|") };
  };
  ade.cloudAccess = {
    read: async () => ({ enabled: true, signInEnd: signInEnd() }),
    onChanged: () => () => undefined,
  };

  // The cloud computers join the preview's connections.
  const remote = ade.remoteRuntime;
  if (remote) {
    const baseTargets = remote.listTargets;
    remote.listTargets = async () => [...((await baseTargets?.()) ?? []), ...computersShown.map(cloudTarget)];
    const baseSnapshot = remote.getConnectionSnapshot;
    remote.getConnectionSnapshot = async () => {
      const snapshot = (await baseSnapshot?.()) ?? { connections: [], connectedCount: 0, updatedAt: Date.now() };
      const extra = computersShown.map((computer) => cloudConnection(computer, awake.has(computer.id), state.scenario === "elsewhere"));
      return {
        ...snapshot,
        connections: [...snapshot.connections, ...extra],
        connectedCount: snapshot.connectedCount + extra.filter((connection) => connection.state === "connected").length,
      };
    };
  }

  // The open project's repo, by its origin: the cloud computers hold the same
  // repo, which is what makes them machines Settings can reach.
  const projectApi = ade.project;
  const getProject = ade.app?.getProject;
  if (projectApi?.listRecent && getProject) {
    const baseRecent = projectApi.listRecent;
    projectApi.listRecent = async () => {
      const list: Array<{ rootPath: string; gitOriginUrl?: string | null }> = (await baseRecent()) ?? [];
      const current: { rootPath?: string; displayName?: string } | null = await getProject().catch(() => null);
      const root = current?.rootPath;
      if (!root) return list;
      return [
        { rootPath: root, displayName: current?.displayName ?? MOCK_REPO.displayName, lastOpenedAt: iso(Date.now()), exists: true, kind: "local", gitOriginUrl: MOCK_REPO.gitOriginUrl },
        ...list.filter((entry) => entry.rootPath !== root),
      ];
    };
  }

  // A cloud computer's own Claude accounts include one pass account per pass (`pass-<id>`).
  const instances = ade.providerInstances;
  if (instances?.list) {
    const baseList = instances.list;
    instances.list = async (args?: { provider?: string }, pin?: unknown) => {
      const base = (await baseList(args, pin)) ?? [];
      if (!cloudTargetOf(pin) || (args?.provider && args.provider !== "claude")) return base;
      const passAccounts = state.passes.map((pass) => ({
        id: claudePassAccountId(pass.key),
        provider: "claude",
        label: (!pass.unreadable && pass.email) || "Claude pass",
        configHome: `/home/ade/.ade/provider-homes/claude/${claudePassAccountId(pass.key)}`,
        isDefault: false,
        createdAt: iso(pass.createdAt || Date.now()),
        ...(!pass.unreadable && pass.email ? { account: { email: pass.email, plan: "max" } } : {}),
        signedIn: !pass.unreadable && pass.state !== "ended",
        ...(!pass.unreadable && pass.state === "ended" ? { loginBroken: true } : {}),
      }));
      return [...base, ...passAccounts];
    };
  }

  // A cloud computer's own AI status: Muse not signed in there (F1 signs it in), OpenCode with no provider.
  const ai = ade.ai;
  // Which machine a sheet's sign-in starts on, so the preview shows the pin it took.
  if (ai?.cliLoginStart) {
    const baseStart = ai.cliLoginStart;
    ai.cliLoginStart = async (args: { provider?: string }, pin?: unknown) => {
      console.info(`[browser mock] ai.cliLoginStart ${args?.provider ?? "?"} on ${cloudTargetOf(pin)?.name ?? "this computer"}`);
      return baseStart(args, pin);
    };
  }
  if (ai?.getStatus) {
    const baseStatus = ai.getStatus;
    ai.getStatus = async (args?: unknown, pin?: unknown) => {
      const status = await baseStatus(args, pin);
      if (!cloudTargetOf(pin)) return status;
      await wait(900);
      const museSignedIn = state.row === "F1";
      return {
        ...status,
        opencodeProviders: (status.opencodeProviders ?? []).map((entry: { signedIn?: boolean }) => ({ ...entry, signedIn: false })),
        providerConnections: {
          ...status.providerConnections,
          muse: { ...(status.providerConnections?.muse ?? { provider: "muse", sources: [] }), provider: "muse", authAvailable: museSignedIn },
        },
      };
    };
  }
}

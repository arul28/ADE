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
import type { CloudSignInId } from "../shared/cloudSignIns";
import type {
  ProviderLoginApplied,
  ProviderLoginProvider,
  ProviderLoginProviderStatus,
  ProviderLoginSignIn,
  ProviderLoginStatus,
} from "../shared/types/providerLogins";

type Scenario = "on" | "none" | "asleep" | "noanswer" | "off" | "unreadable" | "one" | "copilot-fallback" | "elsewhere";

const SCENARIOS: readonly Scenario[] = ["on", "none", "asleep", "noanswer", "off", "unreadable", "one", "copilot-fallback", "elsewhere"];

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
  saved: Set<CloudSignInId>;
  /** The account's picks (place → key, or "key"), as `cloud.inUse` carries them. */
  inUse: Record<string, string>;
  /** Claude's smart balance on ADE Cloud (`setCloudBalance`), off at the start. */
  smartBalance: boolean;
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
    signIn("copilot", MAC_STUDIO, { class: "fixed", account: { email: null, id: "ada-gh" }, inUseOnCloud: true }),
    // Pi: one sign-in per sub-provider; its Claude sign-in never shows.
    signIn("pi", MACBOOK, { slot: "xai", key: "pi/macbook.xai", inUseOnCloud: true }),
    signIn("pi", MAC_STUDIO, { slot: "openai", key: "pi/mac-studio.openai", class: "fixed", inUseOnCloud: true }),
    signIn("pi", MAC_STUDIO, { slot: "anthropic", key: "pi/mac-studio.anthropic", onForCloud: false }),
  ];
  const saved = new Set<CloudSignInId>(["codex", "openrouter"]);
  const state: MockState = { scenario, row, enabled: scenario !== "off", signIns, antigravityAllowedAt: null, saved, inUse: { codex: "key" }, smartBalance: false };
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

function providerRows(state: MockState): ProviderLoginProviderStatus[] {
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
  }));
}

type MockPasses = NonNullable<ProviderLoginStatus["claudePasses"]>;

/** Fake passes in the shape p6 sends; typed loosely here, the page reads them through one guard. */
function claudePasses(state: MockState, withUse: boolean): MockPasses {
  const now = Date.now();
  const base = {
    unreadable: false,
    check: "match",
    legacy: false,
    madeOnLabel: "Mac Studio",
    renewedAt: null,
    expiresAtSource: "estimate",
    noticeDueAt: now + 150 * DAY,
    upload: "account",
    localInstanceId: null,
    appliedHere: withUse,
    homeHasLogin: false,
    smartBalance: false,
    endedAt: null,
  };
  return [
    {
      ...base,
      key: "claude-pass/mock-a",
      label: "ada@example.com",
      email: "ada@example.com",
      on: state.enabled,
      newChats: state.enabled,
      createdAt: now - 165 * DAY,
      expiresAt: now + 200 * DAY,
      endsInDays: 200,
      state: "active",
      use: withUse
        ? {
          state: "seen",
          lastSeenAt: now - 20 * 60_000,
          fiveHour: { usedPct: 42, resetsAt: now + 2 * HOUR, status: "allowed", seenAt: now - 20 * 60_000, resetSinceSeen: false, from: { kind: "pass_turn", label: null } },
          weekly: { usedPct: 18, resetsAt: now + 4 * DAY, status: "allowed", seenAt: now - 20 * 60_000, resetSinceSeen: false, from: { kind: "pass_turn", label: null } },
          models: {},
          from: { kind: "pass_turn", label: null, seenAt: now - 20 * 60_000 },
        }
        : { state: "none_seen" },
    },
    {
      ...base,
      key: "claude-pass/mock-b",
      label: "Claude pass from Mar 2",
      email: null,
      check: "unchecked",
      on: state.enabled,
      newChats: false,
      createdAt: Date.UTC(new Date(now).getUTCFullYear(), 2, 2),
      expiresAt: now + 110 * DAY,
      endsInDays: 110,
      state: "active",
      use: { state: "none_seen" },
    },
    { key: "claude-pass/mock-c", unreadable: true },
  ] as unknown as MockPasses;
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
    providers: providerRows(state),
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
      await wait(300);
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
    cloudSignInStatus: async () => ({
      saved: savedList(),
      unknown: false,
      claude: { state: "cancelled", url: null, awaitingCode: false, message: null, forEmail: null, foundEmail: null, check: null, renewKey: null, savedKey: null, upload: null },
      localAccounts: [],
    }),
    onCloudSignInChanged: () => () => undefined,
    cloudSignInSaveKey: async (id: CloudSignInId) => {
      // The key itself is never kept or logged; only that one was saved.
      console.info(`[browser mock] cloud.cloudSignInSaveKey ${id}`);
      await wait(300);
      state.saved.add(id);
      return { saved: savedList(), unknown: false, claude: null, localAccounts: [] };
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
      return { saved: savedList(), unknown: false, claude: null, localAccounts: [] };
    },
  };
  ade.cloudAccess = {
    read: async () => ({ enabled: true }),
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

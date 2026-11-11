/**
 * ADE Cloud's provider tiles, as data: which words each tile says, from the
 * account part (the sign-ins in the ADE account) and the cloud part (what one
 * cloud computer did with them). Pure: no reads, no React. Every word the
 * ADE Cloud place shows about a sign-in lives here, so a new status field is
 * a change in this one file.
 *
 * The rows are the P7 design's state table: T1–T12 for carried providers,
 * F1–F5 for fallback providers, C1–C9 for Claude.
 */
import {
  newerClaudePassUse,
  type ClaudePassCheck,
  type ClaudePassState,
  type ClaudePassUpload,
  type ClaudePassUseSource,
  type ClaudePassUseView,
  type ClaudePassUseWindow,
  type CloudSignInId,
  type CloudSignInStatus,
} from "../../../../../shared/cloudSignIns";
import type { AiSettingsStatus } from "../../../../../shared/types";
import {
  isClaudePassKey,
  type ProviderLoginApplied,
  type ProviderLoginProvider,
  type ProviderLoginProviderStatus,
  type ProviderLoginSignIn,
  type ProviderLoginStatus,
} from "../../../../../shared/types/providerLogins";
import { NOT_SIGNED_IN_LABEL, SIGNED_IN_LABEL, UNKNOWN_LABEL } from "../providerSignInView";
import type { ProviderTileFact } from "../ProviderTileView";

/** "Sign-ins from your computers reach …": the one sentence under the title. */
export const ADE_CLOUD_REACH_LINE = "Sign-ins from your computers reach each cloud computer in about a minute.";
export const ADE_CLOUD_OFF_BANNER = "Sign-ins are off for ADE Cloud. Cloud chats sign in on each cloud computer.";
export const COPILOT_REPO_LINE = "This login also gives access to your GitHub repos.";

const DAY_MS = 86_400_000;
/** A sign-in that ends within this many days warns on its tile (T12). */
const ENDS_SOON_DAYS = 3;

// ── The Claude pass rows, read through one guard ─────────────────────────

/** One `claudePasses` entry: only the fields the ADE Cloud place reads. */
export type CloudPassRow =
  | { key: string; unreadable: true }
  | {
    key: string;
    unreadable: false;
    label: string;
    email: string | null;
    check: ClaudePassCheck;
    on: boolean;
    newChats: boolean;
    madeOnLabel: string | null;
    createdAt: number;
    renewedAt: number | null;
    expiresAt: number | null;
    expiresAtSource: "estimate" | "claude";
    endsInDays: number;
    state: ClaudePassState;
    endedAt: number | null;
    upload: ClaudePassUpload;
    smartBalance: boolean;
    /** The use this brain saw (a cloud computer: the pass's own turns). Null when the shape is not known. */
    use: ClaudePassUseView | null;
  };

export type ReadableCloudPassRow = Extract<CloudPassRow, { unreadable: false }>;

const PASS_STATES = new Set(["active", "ending_soon", "estimate_passed", "ended"]);
const PASS_UPLOADS = new Set(["account", "pending", "refused"]);
const PASS_CHECKS = new Set(["match", "kept_other", "unchecked"]);
const WINDOW_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUseSource(value: unknown): ClaudePassUseSource | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind !== "pass_turn" && kind !== "account_here") return null;
  return { kind, label: typeof value.label === "string" && value.label.trim() ? value.label : null };
}

function readUseWindow(value: unknown): ClaudePassUseWindow | null {
  if (!isRecord(value)) return null;
  const seenAt = finiteOrNull(value.seenAt);
  const from = readUseSource(value.from);
  if (seenAt == null || !from) return null;
  return {
    usedPct: finiteOrNull(value.usedPct),
    resetsAt: finiteOrNull(value.resetsAt),
    // The account's own reading gives no status: never "limit reached" from it.
    status: from.kind === "pass_turn" && typeof value.status === "string" && WINDOW_STATUSES.has(value.status)
      ? value.status as ClaudePassUseWindow["status"]
      : null,
    seenAt,
    resetSinceSeen: value.resetSinceSeen === true,
    from,
  };
}

/** A pass's use through the guard, as `ClaudePassUseView`; null when the shape is not one ADE knows. */
export function readPassUse(value: unknown): ClaudePassUseView | null {
  if (!isRecord(value)) return null;
  if (value.state === "none_seen") return { state: "none_seen" };
  if (value.state !== "seen") return null;
  const models: Partial<Record<"opus" | "sonnet", ClaudePassUseWindow>> = {};
  if (isRecord(value.models)) {
    for (const family of ["opus", "sonnet"] as const) {
      const window = readUseWindow(value.models[family]);
      if (window) models[family] = window;
    }
  }
  const fiveHour = readUseWindow(value.fiveHour);
  const weekly = readUseWindow(value.weekly);
  const windows = [fiveHour, weekly, models.opus, models.sonnet].filter((window): window is ClaudePassUseWindow => Boolean(window));
  if (windows.length === 0) return { state: "none_seen" };
  const newest = windows.reduce((best, window) => (window.seenAt > best.seenAt ? window : best));
  return { state: "seen", lastSeenAt: newest.seenAt, fiveHour, weekly, models, from: { ...newest.from, seenAt: newest.seenAt } };
}

/**
 * `claudePasses` from a status read, through one guard. The shared type is
 * `ClaudePassStatusEntry[]`, but the cloud part comes from a cloud computer's
 * brain, which can run an older or newer runtime than this app and send
 * another shape. An entry with a missing or wrong field is skipped, never
 * guessed.
 */
export function readClaudePasses(status: ProviderLoginStatus | null | undefined): CloudPassRow[] {
  const rows: CloudPassRow[] = [];
  for (const entry of (status?.claudePasses ?? []) as unknown[]) {
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    if (entry.unreadable === true) {
      rows.push({ key: entry.key, unreadable: true });
      continue;
    }
    if (
      typeof entry.label !== "string"
      || typeof entry.on !== "boolean"
      || typeof entry.newChats !== "boolean"
      || typeof entry.createdAt !== "number"
      || typeof entry.endsInDays !== "number"
      || typeof entry.state !== "string" || !PASS_STATES.has(entry.state)
    ) continue;
    rows.push({
      key: entry.key,
      unreadable: false,
      label: entry.label,
      email: typeof entry.email === "string" && entry.email.trim() ? entry.email : null,
      check: typeof entry.check === "string" && PASS_CHECKS.has(entry.check) ? entry.check as ClaudePassCheck : "match",
      on: entry.on,
      newChats: entry.newChats,
      madeOnLabel: typeof entry.madeOnLabel === "string" && entry.madeOnLabel.trim() ? entry.madeOnLabel : null,
      createdAt: entry.createdAt,
      renewedAt: finiteOrNull(entry.renewedAt),
      expiresAt: finiteOrNull(entry.expiresAt),
      expiresAtSource: entry.expiresAtSource === "claude" ? "claude" : "estimate",
      endsInDays: entry.endsInDays,
      state: entry.state as ClaudePassState,
      endedAt: finiteOrNull(entry.endedAt),
      upload: typeof entry.upload === "string" && PASS_UPLOADS.has(entry.upload) ? entry.upload as ClaudePassUpload : "account",
      smartBalance: entry.smartBalance === true,
      use: readPassUse(entry.use),
    });
  }
  return rows;
}

/**
 * The account side's use of each pass (`cloudSignInStatus().passes[].use`):
 * the limits of the Claude account with the same email that one of the
 * person's computers tracks. By pass key; through the same guard.
 */
export function accountPassUse(passes: CloudSignInStatus["passes"] | null | undefined): ReadonlyMap<string, ClaudePassUseView> {
  const byKey = new Map<string, ClaudePassUseView>();
  for (const pass of (passes ?? []) as unknown[]) {
    if (!isRecord(pass) || typeof pass.key !== "string" || pass.unreadable === true) continue;
    const use = readPassUse(pass.use);
    if (use) byKey.set(pass.key, use);
  }
  return byKey;
}

/**
 * One pass's use from both reads: per window the newer reading, and one from
 * before its reset loses to a current one (`newerClaudePassUse`). The cloud
 * computer's own turns (`pass_turn`) and the account's numbers on a computer
 * (`account_here`) each keep their source, so the card can say where a
 * number comes from.
 */
export function joinedPassUse(cloudRow: CloudPassRow | undefined, accountUse: ClaudePassUseView | undefined): ClaudePassUseView {
  const cloudUse = cloudRow && !cloudRow.unreadable ? cloudRow.use : null;
  return newerClaudePassUse(cloudUse, accountUse ?? null);
}

// ── The two parts ────────────────────────────────────────────────────────

/** The account part: the sign-ins in the ADE account, read through This computer. */
export type AdeCloudAccountPart =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ok"; status: ProviderLoginStatus };

/**
 * The cloud part: what one cloud computer did with the account's sign-ins.
 * - `no_computer`: the account has no cloud computer.
 * - `none_awake`: cloud computers exist and every one is asleep or stopped.
 * - `unreachable`: a cloud computer is awake, but none is a machine this
 *   project can reach now (not connected here, or not set up for this repo).
 * - `loading`: the reporting computer was asked and has not answered yet.
 * - `no_answer`: it did not answer in time, the read failed, or it says it is
 *   not a cloud computer.
 * - `unknown`: the list of cloud computers is not read yet.
 */
export type AdeCloudCloudPart =
  | { state: "unknown" }
  | { state: "no_computer" }
  | { state: "none_awake" }
  | { state: "unreachable" }
  | { state: "loading"; computerName: string }
  | { state: "no_answer"; computerName: string }
  | { state: "ok"; computerName: string; status: ProviderLoginStatus; ai: AiSettingsStatus | null };

export function accountUnreadable(account: AdeCloudAccountPart): boolean {
  if (account.state === "failed") return true;
  if (account.state !== "ok") return false;
  const reason = account.status.thisComputer.reason;
  return (reason === "vault_unavailable" || reason === "ade_cloud_unknown") && account.status.signIns.length === 0;
}

/** False only when the account says the one switch for all of ADE Cloud's sign-ins is off. */
export function cloudSignInsOn(account: AdeCloudAccountPart): boolean {
  return account.state !== "ok" || account.status.cloud.enabled;
}

// ── The page line ────────────────────────────────────────────────────────

export type AdeCloudPageLine = {
  text: string;
  /** Show Re-check beside it. */
  recheck: boolean;
};

/**
 * The line under the title. With 2+ cloud computers the view adds "Checked on
 * <name> ▾" in front of `ADE_CLOUD_REACH_LINE`; the name is not in this text.
 */
export function adeCloudPageLine(account: AdeCloudAccountPart, cloud: AdeCloudCloudPart): AdeCloudPageLine {
  if (accountUnreadable(account)) return { text: "ADE couldn't read your ADE account.", recheck: true };
  switch (cloud.state) {
    case "no_computer":
      return { text: "No cloud computer yet. Each new one starts with these sign-ins.", recheck: false };
    case "none_awake":
      return { text: "Your cloud computers are asleep, so this shows your account's choices.", recheck: true };
    case "unreachable":
      return { text: "ADE can't reach a cloud computer from this project now, so this shows your account's choices.", recheck: true };
    case "no_answer":
      return { text: `${cloud.computerName} didn't answer, so this shows your account's choices.`, recheck: true };
    default:
      return { text: ADE_CLOUD_REACH_LINE, recheck: false };
  }
}

// ── One tile ─────────────────────────────────────────────────────────────

/** `data-state` of the tile, the same states as a computer's tiles. */
export type AdeCloudTileState = "connected" | "sign-in" | "unknown" | "checking";

export type AdeCloudTileAction =
  /** The one switch of a provider with exactly one sign-in. */
  | { kind: "switch"; key: string; on: boolean; confirmOn: boolean }
  | { kind: "recheck" }
  /** Sign in on this computer (carried providers). */
  | { kind: "sign-in-here" }
  /** Copy Antigravity's sign-in from this Mac's Keychain. */
  | { kind: "allow-keychain" }
  /** Sign in on the reporting cloud computer (fallback providers). Step 2. */
  | { kind: "sign-in-cloud" }
  /** Approve a Claude pass, or renew one. Step 4. */
  | { kind: "claude-pass"; renewKey: string | null };

export type AdeCloudTile = {
  provider: ProviderLoginProvider;
  /** The design row that decided the tile ("T3", "F2", "C2", …). */
  row: string;
  state: AdeCloudTileState;
  chipLabel: string;
  chipTone: "ok" | "warn" | undefined;
  facts: readonly ProviderTileFact[];
  action: AdeCloudTileAction | null;
};

export type AdeCloudTileInput = {
  provider: ProviderLoginProvider;
  account: AdeCloudAccountPart;
  cloud: AdeCloudCloudPart;
  /** The saved ADE Cloud keys (`cloud.cloudSignInStatus`); null before the read. */
  saved: CloudSignInStatus["saved"] | null;
  /** The account read reached the Mac in front of the person, so its Keychain state is this Mac's. */
  keychainIsThisMac: boolean;
  /** The account side's use of each pass (`accountPassUse`); empty before the read. */
  passUse?: ReadonlyMap<string, ClaudePassUseView>;
  now: number;
};

const CHECKING_TILE = { row: "checking", state: "checking", chipLabel: "Checking…", chipTone: undefined, facts: [], action: null } as const;

function signedIn(row: string, facts: ProviderTileFact[], action: AdeCloudTileAction | null = null) {
  return { row, state: "connected" as const, chipLabel: SIGNED_IN_LABEL, chipTone: "ok" as const, facts, action };
}

function notSignedIn(row: string, text: string, action: AdeCloudTileAction | null = null, tone?: ProviderTileFact["tone"]) {
  return { row, state: "sign-in" as const, chipLabel: NOT_SIGNED_IN_LABEL, chipTone: "warn" as const, facts: [{ text, tone }], action };
}

function unknown(row: string, text: string, action: AdeCloudTileAction | null = null) {
  return { row, state: "unknown" as const, chipLabel: UNKNOWN_LABEL, chipTone: undefined, facts: [{ text }], action };
}

/** "Nov 12", or "Nov 12, 2027" outside this year. */
export function shortDate(ms: number, now: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The saved ADE Cloud key that stands in for a provider, by its key row. */
const SAVED_KEY_FOR: Partial<Record<ProviderLoginProvider, CloudSignInId>> = {
  codex: "codex",
  cursor: "cursor",
  droid: "droid",
  grok: "grok",
  copilot: "copilot",
  devin: "devin",
  muse: "muse",
  opencode: "openrouter",
  pi: "openrouter",
};

function hasSavedKey(provider: ProviderLoginProvider, saved: CloudSignInStatus["saved"] | null): boolean {
  const id = SAVED_KEY_FOR[provider];
  return Boolean(id && saved?.some((entry) => entry.id === id && entry.saved));
}

/** What the reporting computer applied for a provider: its own place, else one of its `pi:<sub>` places. */
function appliedFor(provider: ProviderLoginProvider, cloud: AdeCloudCloudPart, inUseKey: string | null): ProviderLoginApplied | null {
  if (cloud.state !== "ok") return null;
  const applied = cloud.status.applied ?? [];
  return applied.find((entry) => entry.place === provider)
    ?? (inUseKey ? applied.find((entry) => entry.provider === provider && entry.key === inUseKey) : undefined)
    ?? applied.find((entry) => entry.provider === provider)
    ?? null;
}

function providerRow(account: AdeCloudAccountPart, provider: ProviderLoginProvider): ProviderLoginProviderStatus | null {
  return account.state === "ok" ? account.status.providers.find((row) => row.provider === provider) ?? null : null;
}

/** Copilot is carried only when the status says so; everything else about it follows from that. */
function isCarried(provider: ProviderLoginProvider, row: ProviderLoginProviderStatus | null): boolean {
  return row?.carry === "carried";
}

/** A computer's name with its hyphens kept on one line ("cloud-a" never breaks as "cloud-" / "a"). */
function keepWhole(name: string): string {
  return name.replace(/-/g, "\u2011");
}

function originLine(signIn: ProviderLoginSignIn): string {
  return `From ${signIn.origin.label}`;
}

function carriedTile(input: AdeCloudTileInput, row: ProviderLoginProviderStatus | null): Omit<AdeCloudTile, "provider"> {
  const { provider, account, cloud, now } = input;
  if (account.state !== "ok") return CHECKING_TILE;
  const signIns = account.status.signIns.filter((signIn) => signIn.provider === provider && !isClaudePassKey(signIn.key));
  const inUse = signIns.find((signIn) => signIn.inUseOnCloud)
    // The account picks one of the switched-on sign-ins; show it until it says which.
    ?? signIns.find((signIn) => signIn.onForCloud)
    ?? null;
  const applied = appliedFor(provider, cloud, inUse?.key ?? null);
  const cloudName = cloud.state === "ok" ? cloud.computerName : null;
  const only = signIns.length === 1 ? signIns[0]! : null;
  const switchFor = (signIn: ProviderLoginSignIn | null): AdeCloudTileAction | null =>
    signIn ? { kind: "switch", key: signIn.key, on: signIn.onForCloud, confirmOn: provider === "copilot" } : null;
  // Why the GitHub login matters: never cut, at any width.
  const repoLine: ProviderTileFact[] = provider === "copilot" ? [{ text: COPILOT_REPO_LINE, whole: true }] : [];

  if (applied?.ownerOff) return unknown("T8", "ADE couldn't renew it in time", { kind: "recheck" });
  if (applied?.state === "failed") {
    return unknown("T7", `Couldn't put it on ${cloudName ? keepWhole(cloudName) : "the cloud computer"}. Tries again soon.`, { kind: "recheck" });
  }
  if (applied?.state === "own" || applied?.state === "kept_local") return signedIn("T5", [{ text: "Signed in on the cloud computer" }]);
  // The account picks the saved key, or no sign-in is on and the key stands in ("Used when no sign-in is on").
  const keySaved = hasSavedKey(provider, input.saved);
  const keyPicked = account.status.cloud.inUse[provider] === "key";
  if (keySaved && (keyPicked || !signIns.some((signIn) => signIn.onForCloud))) {
    return signedIn("T6", [{ text: "Copied key" }]);
  }
  if (inUse) {
    const action = switchFor(only);
    if (applied?.state === "applied" && applied.key !== inUse.key && cloudName) {
      return signedIn("T4", [{ text: `${originLine(inUse)} · On its way to ${cloudName}` }, ...repoLine], action);
    }
    const expiresAt = parseTime(inUse.expiresAt);
    const endsSoon = expiresAt != null
      && expiresAt - now <= ENDS_SOON_DAYS * DAY_MS
      && (inUse.class === "fixed" || applied?.renewalSafe === false);
    if (endsSoon) {
      return signedIn("T12", [{ text: `${originLine(inUse)} · Ends on ${shortDate(expiresAt, now)}`, tone: "warn" }, ...repoLine], action);
    }
    const email = inUse.account?.email?.trim() || inUse.account?.id?.trim() || null;
    return signedIn("T3", [{ text: email ? `${email} · ${originLine(inUse)}` : originLine(inUse) }, ...repoLine], action);
  }
  if (signIns.length > 0) return notSignedIn("T9", "Off for ADE Cloud", switchFor(only));
  if (provider === "antigravity" && input.keychainIsThisMac && row?.keychain?.canAllow) {
    return notSignedIn("T11", "It is in this Mac's Keychain", { kind: "allow-keychain" });
  }
  // Copilot comes from a computer's GitHub CLI login, once it is turned on there (this computer's page).
  if (provider === "copilot") {
    const gh = row?.ghCli ?? null;
    if (gh?.allowed && (gh.unsupported || gh.lastError)) {
      return notSignedIn("T13", "Couldn't copy this computer's GitHub CLI login", { kind: "sign-in-here" });
    }
    return notSignedIn("T10", "Turn on a GitHub CLI login on a computer", { kind: "sign-in-here" });
  }
  return notSignedIn("T10", "Sign in on a computer to use it here", { kind: "sign-in-here" });
}

/** Whether the reporting computer has its own login for a fallback provider (the P1 disk read). */
function cloudLoginFor(provider: ProviderLoginProvider, ai: AiSettingsStatus | null): boolean | null {
  if (!ai) return null;
  if (provider === "opencode") return (ai.opencodeProviders ?? []).some((entry) => entry.signedIn === true);
  const connections = ai.providerConnections as Partial<Record<string, { authAvailable?: boolean }>> | undefined;
  const connection = connections?.[provider];
  return connection ? connection.authAvailable === true : null;
}

function fallbackTile(input: AdeCloudTileInput): Omit<AdeCloudTile, "provider"> {
  const { provider, cloud } = input;
  const login = cloud.state === "ok" ? cloudLoginFor(provider, cloud.ai) : null;
  if (login === true) return signedIn("F1", [{ text: "Signed in on the cloud computer" }]);
  if (hasSavedKey(provider, input.saved)) return signedIn("F3", [{ text: "Copied key" }]);
  switch (cloud.state) {
    case "no_computer":
      return notSignedIn("F4", "Sign in once you have a cloud computer, or use a key");
    case "none_awake":
      return unknown("F5", "Sign in on the cloud computer when it is awake");
    case "unreachable":
    case "no_answer":
      return unknown("F5", "Sign in on the cloud computer when ADE can reach it");
    case "ok":
      // The status answered and the AI read did not (yet): the login is not known.
      if (login === null && cloud.ai == null) return CHECKING_TILE;
      return notSignedIn("F2", `Sign in on ${keepWhole(cloud.computerName)}, or use a key`, { kind: "sign-in-cloud" });
    default:
      return CHECKING_TILE;
  }
}

/** A window's share as words, or null when there is no current number. */
function sharePct(window: ClaudePassUseWindow | null): string | null {
  return window && window.usedPct != null && !window.resetSinceSeen ? `${Math.round(window.usedPct)} %` : null;
}

/**
 * The use line of the Claude tile (U1–U3): the weekly share first, since the
 * weekly limit is the one a pass runs out of. Numbers from the same account
 * on a computer say which computer.
 */
export function passUseLine(use: ClaudePassUseView): string {
  if (use.state !== "seen") return "No use seen yet";
  const weekly = sharePct(use.weekly);
  const fiveHour = sharePct(use.fiveHour);
  const lead = weekly ? use.weekly : fiveHour ? use.fiveHour : null;
  if (!lead) return "No use seen yet";
  const parts: string[] = [];
  if (weekly) parts.push(`Weekly ${weekly}`);
  // Both shares only when both come from the pass's own turns; else the lead and where it is from.
  const bothFromTurns = use.weekly?.from.kind === "pass_turn" && use.fiveHour?.from.kind === "pass_turn";
  if (fiveHour && (!weekly || bothFromTurns)) parts.push(`5-hour ${fiveHour}`);
  if (lead.from.kind === "account_here") parts.push(`From ${lead.from.label ?? "this computer"}`);
  return parts.join(" · ");
}

function claudeTile(input: AdeCloudTileInput): Omit<AdeCloudTile, "provider"> {
  const { account, cloud, now } = input;
  if (account.state !== "ok") return CHECKING_TILE;
  const passes = readClaudePasses(account.status);
  const cloudPasses = cloud.state === "ok" ? readClaudePasses(cloud.status) : [];
  const readable = passes.filter((pass): pass is ReadableCloudPassRow => !pass.unreadable);
  if (passes.length === 0) return notSignedIn("C1", "Approve a Claude pass for ADE Cloud", { kind: "claude-pass", renewKey: null });
  if (readable.length === 0) return unknown("C7", "Couldn't read your Claude pass");
  if (readable.every((pass) => pass.state === "ended")) {
    const newest = readable.reduce((best, pass) => ((pass.endedAt ?? 0) > (best.endedAt ?? 0) ? pass : best));
    const when = newest.endedAt != null ? ` on ${shortDate(newest.endedAt, now)}` : "";
    return notSignedIn("C5", `Claude ended your pass${when}`, { kind: "claude-pass", renewKey: newest.key }, "crit");
  }
  const on = readable.filter((pass) => pass.on && pass.state !== "ended");
  if (on.length === 0) return notSignedIn("C6", "Off for ADE Cloud");
  const current = on.find((pass) => pass.newChats) ?? on[0]!;
  const label = current.email ?? `Claude pass from ${shortDate(current.createdAt, now)}`;
  const more = on.length > 1 ? ` · ${on.length} passes` : "";
  const useLine: ProviderTileFact = { text: passUseLine(joinedPassUse(cloudPasses.find((pass) => pass.key === current.key), input.passUse?.get(current.key))) };
  if (current.upload !== "account") return signedIn("C9", [{ text: `${label} · Kept on this computer for now${more}` }, useLine]);
  if (current.state === "ending_soon") {
    const days = Math.max(0, Math.round(current.endsInDays));
    return signedIn(
      on.length > 1 ? "C8" : "C3",
      [{ text: `${label} · Cloud pass · Ends in ${days} day${days === 1 ? "" : "s"}${more}`, tone: "warn" }, useLine],
      { kind: "claude-pass", renewKey: current.key },
    );
  }
  if (current.state === "estimate_passed") {
    return signedIn(
      on.length > 1 ? "C8" : "C4",
      [{ text: `${label} · Its expected end date has passed${more}`, tone: "warn" }, useLine],
      { kind: "claude-pass", renewKey: current.key },
    );
  }
  return signedIn(on.length > 1 ? "C8" : "C2", [{ text: `${label} · Cloud pass${more}` }, useLine]);
}

/** One provider's tile on ADE Cloud. */
export function adeCloudTile(input: AdeCloudTileInput): AdeCloudTile {
  const { provider, account } = input;
  const decide = (): Omit<AdeCloudTile, "provider"> => {
    if (!cloudSignInsOn(account)) return notSignedIn("T1", "Sign-ins are off for ADE Cloud");
    if (accountUnreadable(account)) return unknown("T2", "Couldn't read your ADE account");
    if (provider === "claude") return claudeTile(input);
    if (account.state !== "ok") return CHECKING_TILE;
    const row = providerRow(account, provider);
    return isCarried(provider, row) ? carriedTile(input, row) : fallbackTile(input);
  };
  return { provider, ...decide() };
}

/** The order of the tiles: what works, then what is not known, then what asks for something. */
export const ADE_CLOUD_TILE_ORDER: Record<AdeCloudTileState, number> = {
  connected: 0,
  unknown: 1,
  "sign-in": 2,
  checking: 3,
};

/**
 * The use of each Claude pass, as its own turns report it (P6 step 3).
 *
 * A pass account has no login file, so the usage poll cannot read its limits.
 * Claude Code reports them in the turn instead: a `rate_limit_event` carries
 * `rate_limit_info` (SDK `SDKRateLimitInfo`):
 *   status          "allowed" | "allowed_warning" | "rejected"   (always)
 *   rateLimitType   "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet"
 *                   | "seven_day_overage_included" | "overage"   (optional)
 *   utilization     number, optional; ADE reads ≤ 1 as a share (`utilizationToPercent`)
 *   resetsAt        epoch seconds, optional
 *   overage*, isUsingOverage, surpassedThreshold                    (not kept here)
 * One event names one window. An `allowed` event can come without
 * `utilization`, so a window can be "seen" with no share.
 *
 * Kept per pass key in memory, and in one small file (`claude-pass-use.json`
 * in the ADE directory): keys, shares, reset times and status only, never a
 * token or an email. The file is written at most once a minute, from an event
 * or from the sign-in sync's own pass; there is no timer here.
 */

import fs from "node:fs";
import path from "node:path";
import type { UsageSnapshot, UsageWindow } from "../../../shared/types/usage";
import { claudePassKeyOfAccountId, isClaudePassKey } from "../../../shared/types/providerLogins";
import type { ClaudePassCheck, ClaudePassUseSource, ClaudePassUseView, ClaudePassUseWindow } from "../../../shared/cloudSignIns";
import { normalizeResetsAtMs, utilizationToPercent } from "../../../shared/claudeSessionQuota";
import { captureError } from "../../../shared/sentry/capture";

export const CLAUDE_PASS_USE_FILE = "claude-pass-use.json";
/** At most one file write per minute. */
const WRITE_EVERY_MS = 60_000;
/** A file larger than this is not read (a pass row is about 250 bytes). */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PASSES = 64;
const FIVE_HOUR_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;

type Status = "allowed" | "allowed_warning" | "rejected";

/** One window of one pass, as the last event about it said. */
export type ClaudePassSeenWindow = {
  /** 0–100, or null when the event gave no share. */
  usedPct: number | null;
  /** Epoch ms, or null. */
  resetsAt: number | null;
  status: Status;
  /** Epoch ms of the event. */
  seenAt: number;
};

type PassUse = {
  fiveHour?: ClaudePassSeenWindow;
  weekly?: ClaudePassSeenWindow;
  /** Weekly windows for one model family (`seven_day_opus`, `seven_day_sonnet`). */
  models?: Partial<Record<"opus" | "sonnet", ClaudePassSeenWindow>>;
};

export type { ClaudePassUseView, ClaudePassUseWindow } from "../../../shared/cloudSignIns";

const PASS_TURN: ClaudePassUseSource = { kind: "pass_turn", label: null };

const useByKey = new Map<string, PassUse>();
let filePath: string | null = null;
let dirty = false;
let lastWriteAt = 0;
let writing = false;
let writeFailureReported = false;


function isStatus(value: unknown): value is Status {
  return value === "allowed" || value === "allowed_warning" || value === "rejected";
}

function readWindow(value: unknown): ClaudePassSeenWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const num = (field: unknown): number | null => (typeof field === "number" && Number.isFinite(field) ? field : null);
  const seenAt = num(record.seenAt);
  if (!isStatus(record.status) || seenAt == null) return undefined;
  const usedPct = num(record.usedPct);
  return {
    usedPct: usedPct == null ? null : Math.max(0, Math.min(100, usedPct)),
    resetsAt: num(record.resetsAt),
    status: record.status,
    seenAt,
  };
}

/** Start the file store (the brain, at install). Reads the file once; a bad or large file is ignored. */
export function configureClaudePassUse(args: { adeDir: string }): void {
  filePath = path.join(args.adeDir, CLAUDE_PASS_USE_FILE);
  useByKey.clear();
  dirty = false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { v?: unknown; passes?: unknown };
    if (parsed?.v !== 1 || !parsed.passes || typeof parsed.passes !== "object") return;
    for (const [key, raw] of Object.entries(parsed.passes as Record<string, unknown>).slice(0, MAX_PASSES)) {
      if (!isClaudePassKey(key) || !raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const models = row.models && typeof row.models === "object" ? row.models as Record<string, unknown> : {};
      const use: PassUse = {};
      const fiveHour = readWindow(row.fiveHour);
      const weekly = readWindow(row.weekly);
      if (fiveHour) use.fiveHour = fiveHour;
      if (weekly) use.weekly = weekly;
      for (const family of ["opus", "sonnet"] as const) {
        const window = readWindow(models[family]);
        if (window) (use.models ??= {})[family] = window;
      }
      if (use.fiveHour || use.weekly || use.models) useByKey.set(key, use);
    }
  } catch {
    // No file yet, or a file this version can't read: start empty.
  }
}

function sameWindow(a: ClaudePassSeenWindow | undefined, b: ClaudePassSeenWindow): boolean {
  return Boolean(a) && a!.usedPct === b.usedPct && a!.resetsAt === b.resetsAt && a!.status === b.status;
}

/**
 * Keep what one `rate_limit_event` of a chat says, when the chat runs on a
 * pass account. True when it changed a share, a reset time or a status. A
 * repeat of the same numbers only moves `seenAt` in memory. Never throws.
 */
export function noteClaudePassRateLimit(
  instanceId: string | null | undefined,
  info: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): boolean {
  const key = claudePassKeyOfAccountId(instanceId);
  if (!key || !info || !isStatus(info.status)) return false;
  const type = info.rateLimitType;
  const slot = type === "five_hour" ? "fiveHour"
    : type === "seven_day" ? "weekly"
      : type === "seven_day_opus" ? "opus"
        : type === "seven_day_sonnet" ? "sonnet"
          : null;
  // No window named (or the extra-usage windows): not a pass's plan use.
  if (!slot) return false;
  if (!useByKey.has(key) && useByKey.size >= MAX_PASSES) return false;
  const use = useByKey.get(key) ?? {};
  const previous = slot === "fiveHour" || slot === "weekly" ? use[slot] : use.models?.[slot];
  const resetsAt = normalizeResetsAtMs(info.resetsAt);
  const share = utilizationToPercent(info.utilization);
  // A refusal of this window is a full window; no share keeps the last share of the same period.
  const usedPct = share ?? (info.status === "rejected" ? 100 : previous && previous.resetsAt === resetsAt ? previous.usedPct : null);
  const next: ClaudePassSeenWindow = { usedPct, resetsAt, status: info.status, seenAt: now };
  const changed = !sameWindow(previous, next);
  if (slot === "fiveHour" || slot === "weekly") use[slot] = next;
  else (use.models ??= {})[slot] = next;
  useByKey.set(key, use);
  if (changed) {
    dirty = true;
    flushClaudePassUse(now);
  }
  return changed;
}

/** Write the file when something changed and the last write is a minute old. No timer; callers are events and the sync's pass. */
export function flushClaudePassUse(now: number = Date.now(), options: { force?: boolean } = {}): void {
  if (!filePath || !dirty || writing) return;
  if (!options.force && now - lastWriteAt < WRITE_EVERY_MS) return;
  const passes: Record<string, PassUse> = {};
  for (const [key, use] of useByKey) passes[key] = use;
  const body = JSON.stringify({ v: 1, passes });
  const target = filePath;
  const temp = `${target}.${process.pid}.tmp`;
  dirty = false;
  lastWriteAt = now;
  writing = true;
  void fs.promises.writeFile(temp, body, { mode: 0o600 })
    .then(() => fs.promises.rename(temp, target))
    .catch((error: unknown) => {
      // Kept dirty, so the next flush tries again; reported once per process.
      dirty = true;
      if (!writeFailureReported) {
        writeFailureReported = true;
        captureError(error, {
          level: "warning",
          handled: true,
          fingerprint: ["claude_pass", "use_write_failed"],
          tags: { area: "claude_pass", code: (error as NodeJS.ErrnoException)?.code ?? "unknown" },
        });
      }
      void fs.promises.rm(temp, { force: true }).catch(() => undefined);
    })
    .finally(() => {
      writing = false;
    });
}

/** Drop the use of passes that are gone (removed from the account). */
export function keepClaudePassUse(keys: ReadonlySet<string>): void {
  for (const key of [...useByKey.keys()]) {
    if (!keys.has(key)) {
      useByKey.delete(key);
      dirty = true;
    }
  }
}

function viewWindow(window: ClaudePassSeenWindow | undefined, now: number): ClaudePassUseWindow | null {
  if (!window) return null;
  return { ...window, resetSinceSeen: window.resetsAt != null && window.resetsAt <= now, from: PASS_TURN };
}

/** `claudePasses[].use` for one pass key. */
export function claudePassUseOf(key: string, now: number = Date.now()): ClaudePassUseView {
  const use = useByKey.get(key);
  if (!use || (!use.fiveHour && !use.weekly && !use.models)) return { state: "none_seen" };
  const seen = [use.fiveHour, use.weekly, use.models?.opus, use.models?.sonnet]
    .filter((window): window is ClaudePassSeenWindow => Boolean(window));
  const models: Partial<Record<"opus" | "sonnet", ClaudePassUseWindow>> = {};
  for (const family of ["opus", "sonnet"] as const) {
    const window = viewWindow(use.models?.[family], now);
    if (window) models[family] = window;
  }
  const lastSeenAt = Math.max(...seen.map((window) => window.seenAt));
  return {
    state: "seen",
    lastSeenAt,
    fiveHour: viewWindow(use.fiveHour, now),
    weekly: viewWindow(use.weekly, now),
    models,
    from: { ...PASS_TURN, seenAt: lastSeenAt },
  };
}

/** The email a pass can be matched by: only one Claude named (`check: "match"`), trimmed and lower-case. */
export function claudePassVerifiedEmail(pass: { email: string | null | undefined; check: ClaudePassCheck }): string | null {
  if (pass.check !== "match") return null;
  const email = pass.email?.trim().toLowerCase() ?? "";
  return email.includes("@") ? email : null;
}

function windowSeenAt(window: UsageWindow, fallback: number): number {
  const read = Date.parse(window.readAt ?? "");
  return Number.isFinite(read) ? read : fallback;
}

/**
 * A pass's use from the Claude account with the same verified email in this
 * computer's usage snapshot (the shown view: this computer's own accounts,
 * each with the freshest reading of any of the person's computers, and the
 * accounts only another computer holds). Pass accounts are never a source.
 * Two accounts with the email: the one with the newest reading. No match, or
 * no current window: `none_seen`. Reads memory only.
 */
export function claudePassAccountUse(
  pass: { email: string | null | undefined; check: ClaudePassCheck },
  snapshot: Pick<UsageSnapshot, "windows" | "accounts"> | null | undefined,
  now: number = Date.now(),
): ClaudePassUseView {
  const email = claudePassVerifiedEmail(pass);
  if (!email || !snapshot) return { state: "none_seen" };
  let best: { windows: ClaudePassUseWindow[]; fiveHour: ClaudePassUseWindow | null; weekly: ClaudePassUseWindow | null; seenAt: number } | null = null;
  for (const account of snapshot.accounts ?? []) {
    if (account.provider !== "claude" || account.email?.trim().toLowerCase() !== email) continue;
    if (claudePassKeyOfAccountId(account.instanceId)) continue;
    const machine = account.readingFrom ?? account.machines[0];
    const checkedAt = Date.parse(machine?.checkedAt ?? "");
    const from: ClaudePassUseSource = { kind: "account_here", label: machine?.label ?? null };
    const pick = (windowType: "five_hour" | "weekly"): ClaudePassUseWindow | null => {
      const window = snapshot.windows.find((candidate) => candidate.accountId === account.id
        && candidate.windowType === windowType && Date.parse(candidate.resetsAt) > now);
      if (!window) return null;
      return {
        usedPct: Math.max(0, Math.min(100, window.percentUsed)),
        resetsAt: Date.parse(window.resetsAt),
        status: null,
        seenAt: windowSeenAt(window, Number.isFinite(checkedAt) ? checkedAt : 0),
        resetSinceSeen: false,
        from,
      };
    };
    const fiveHour = pick("five_hour");
    const weekly = pick("weekly");
    const windows = [fiveHour, weekly].filter((window): window is ClaudePassUseWindow => Boolean(window));
    if (windows.length === 0) continue;
    const seenAt = Math.max(...windows.map((window) => window.seenAt));
    if (!best || seenAt > best.seenAt) best = { windows, fiveHour, weekly, seenAt };
  }
  if (!best) return { state: "none_seen" };
  return {
    state: "seen",
    lastSeenAt: best.seenAt,
    fiveHour: best.fiveHour,
    weekly: best.weekly,
    models: {},
    from: { ...best.windows[0]!.from, seenAt: best.seenAt },
  };
}

/**
 * The usage windows of a pass account for the usage poll: only a window with
 * a share and a reset time still ahead. An empty list means "nothing known",
 * never 0 %.
 */
export function claudePassUsageWindows(instanceId: string, now: number = Date.now()): UsageWindow[] {
  const key = claudePassKeyOfAccountId(instanceId);
  const use = key ? useByKey.get(key) : undefined;
  if (!use) return [];
  const windows: UsageWindow[] = [];
  const add = (windowType: "five_hour" | "weekly", window: ClaudePassSeenWindow | undefined, durationMs: number) => {
    if (!window || window.usedPct == null || window.resetsAt == null || window.resetsAt <= now) return;
    const modelBreakdown: Record<string, number> = {};
    if (windowType === "weekly") {
      for (const family of ["opus", "sonnet"] as const) {
        const model = use.models?.[family];
        if (model?.usedPct != null && model.resetsAt != null && model.resetsAt > now) modelBreakdown[family] = model.usedPct;
      }
    }
    windows.push({
      provider: "claude",
      windowType,
      percentUsed: window.usedPct,
      resetsAt: new Date(window.resetsAt).toISOString(),
      resetsInMs: window.resetsAt - now,
      windowDurationMs: durationMs,
      readAt: new Date(window.seenAt).toISOString(),
      ...(Object.keys(modelBreakdown).length ? { modelBreakdown } : {}),
    });
  };
  add("five_hour", use.fiveHour, FIVE_HOUR_MS);
  add("weekly", use.weekly, WEEK_MS);
  return windows;
}

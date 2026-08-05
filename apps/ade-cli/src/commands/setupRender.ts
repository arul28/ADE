/**
 * Terminal rendering for `ade setup`.
 *
 * Split out from the orchestration in ./setup so the layout is unit-testable
 * without running an install: every function here is pure except the reporter,
 * which owns the only stream writes.
 *
 * Layout contract (chosen with the user, do not drift):
 *   - finished steps scroll away as static lines; only the active step animates
 *   - a failure states the reason in plain language AND the fix, inline
 *   - the closing summary recaps every step; the "What's left" block appears
 *     only when something actually needs the user
 */

export type SetupStepId =
  | "runtime"
  | "native"
  | "tools"
  | "account"
  | "desktop";

/** `ok`/`skipped`/`failed` deliberately mirror ConnectStepState in ./connect. */
export type SetupStepState =
  | "pending"
  | "active"
  | "ok"
  | "skipped"
  | "failed";

export type SetupStep = {
  id: SetupStepId;
  label: string;
  state: SetupStepState;
  /** Short human detail: a version, a duration, or why it failed. */
  detail: string;
  /** Command that resolves a failure. Printed inline and in the summary. */
  nextAction?: string;
  /** Where the thing landed, shown in the summary when we know it. */
  location?: string;
};

export type SetupProgress = {
  /** 0..1 when known; null renders an indeterminate marker instead of a bar. */
  fraction: number | null;
  receivedBytes?: number | null;
  totalBytes?: number | null;
  bytesPerSecond?: number | null;
  /** Sub-item currently being worked on, e.g. `claude-code`. */
  item?: string | null;
};

export type TerminalCapabilities = {
  /** A real terminal we may prompt on and redraw in. */
  interactive: boolean;
  /** Cursor movement and in-place redraw are safe. */
  ansi: boolean;
  color: boolean;
  unicode: boolean;
  columns: number;
};

// Built from a char code so no raw 0x1B byte ever lands in this source file --
// a literal escape survives compilation fine but corrupts in diffs, editors,
// and anything that normalizes control characters.
const CSI = `${String.fromCharCode(27)}[`;
/** Carriage return + erase-whole-line: what rewrites the animated line in place. */
const CLEAR_LINE = `\r${CSI}2K`;

const BANNER = String.raw`
     _    ____  _____
    / \  |  _ \| ____|
   / _ \ | | | |  _|
  / ___ \| |_| | |___
 /_/   \_\____/|_____|
`;

export function detectTerminalCapabilities(
  stream: { isTTY?: boolean; columns?: number },
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TerminalCapabilities {
  const isTty = stream.isTTY === true;
  // CI passes isTTY often enough, but redraw there produces unreadable logs.
  // Treat it as a pipe.
  const isCi = Boolean(env.CI && env.CI !== "0" && env.CI !== "false");
  const dumb = env.TERM === "dumb";
  const ansi = isTty && !isCi && !dumb;
  const color = ansi && env.NO_COLOR === undefined && env.ADE_NO_COLOR !== "1";
  // Legacy conhost renders box-drawing and check marks as mojibake. Modern
  // hosts advertise themselves; assume ASCII on Windows when none of them do.
  const modernWindowsHost = Boolean(
    env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI || env.TERM,
  );
  const unicode = ansi && (platform !== "win32" || modernWindowsHost);
  return {
    interactive: isTty && !isCi,
    ansi,
    color,
    unicode,
    columns: Math.max(40, Math.min(stream.columns ?? 80, 120)),
  };
}

function paint(text: string, code: string, caps: TerminalCapabilities): string {
  return caps.color ? `${CSI}${code}m${text}${CSI}0m` : text;
}

export function stateSymbol(
  state: SetupStepState,
  caps: TerminalCapabilities,
): string {
  const unicodeSymbols: Record<SetupStepState, string> = {
    pending: " ",
    active: "·",
    ok: "✓",
    skipped: "-",
    failed: "✗",
  };
  const asciiSymbols: Record<SetupStepState, string> = {
    pending: " ",
    active: ">",
    ok: "+",
    skipped: "-",
    failed: "x",
  };
  const symbol = caps.unicode ? unicodeSymbols[state] : asciiSymbols[state];
  if (state === "ok") return paint(symbol, "32", caps);
  if (state === "failed") return paint(symbol, "31", caps);
  return symbol;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 MB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function renderProgressBar(
  fraction: number,
  width: number,
  caps: TerminalCapabilities,
): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filledCount = Math.round(clamped * width);
  const [filledChar, emptyChar] = caps.unicode
    ? ["█", "░"]
    : ["#", "."];
  return filledChar.repeat(filledCount) + emptyChar.repeat(width - filledCount);
}

/** The one animated line: `###...  38%  Desktop app - 412/1084 MB - 9.4 MB/s`. */
export function formatActiveLine(
  step: SetupStep,
  progress: SetupProgress | null,
  caps: TerminalCapabilities,
): string {
  const parts: string[] = [];
  if (progress?.fraction != null) {
    const percent = Math.round(Math.max(0, Math.min(1, progress.fraction)) * 100);
    parts.push(renderProgressBar(progress.fraction, 12, caps));
    parts.push(`${String(percent).padStart(3, " ")}%`);
  } else {
    parts.push(stateSymbol("active", caps));
  }
  parts.push(step.label);

  const suffix: string[] = [];
  if (progress?.item) suffix.push(progress.item);
  if (
    typeof progress?.receivedBytes === "number" &&
    typeof progress?.totalBytes === "number" &&
    progress.totalBytes > 0
  ) {
    suffix.push(
      `${formatBytes(progress.receivedBytes)}/${formatBytes(progress.totalBytes)}`,
    );
  } else if (typeof progress?.receivedBytes === "number") {
    suffix.push(formatBytes(progress.receivedBytes));
  }
  if (
    typeof progress?.bytesPerSecond === "number" &&
    progress.bytesPerSecond > 0
  ) {
    suffix.push(`${formatBytes(progress.bytesPerSecond)}/s`);
  }
  const separator = caps.unicode ? " · " : " - ";
  const line = suffix.length > 0
    ? `  ${parts.join("  ")}${separator}${suffix.join(separator)}`
    : `  ${parts.join("  ")}`;
  // Never wrap: a wrapped line cannot be erased by a single clear-line, which
  // would leave orphaned progress bars scrolling up the screen.
  return line.length > caps.columns ? line.slice(0, caps.columns - 1) : line;
}

/** A finished step, as it scrolls away: `+ Agent CLIs   codex, claude-code`. */
export function formatCompletedLine(
  step: SetupStep,
  caps: TerminalCapabilities,
): string {
  const label = step.label.padEnd(LABEL_WIDTH, " ");
  const head = `  ${stateSymbol(step.state, caps)} ${label} ${step.detail}`.trimEnd();
  if (step.state !== "failed" || !step.nextAction) return head;
  // The fix goes inline, under the failure, aligned past the symbol column.
  return `${head}\n      fix later with:  ${step.nextAction}`;
}

export type SetupTotals = {
  elapsedMs: number;
  downloadedBytes: number;
};

/**
 * What the recovery command gets the user, for the "What's left" block.
 *
 * The failure reason is already on the step's own line two rows above, so
 * repeating it there would read as "ade connect -- sign-in didn't finish".
 * What a stuck user needs is what the command is *for*.
 */
const NEXT_ACTION_PURPOSE: Record<SetupStepId, string> = {
  runtime: "reinstall the ADE runtime",
  native: "reinstall the ADE runtime",
  tools: "fetch the agent CLIs",
  account: "link this machine to your account",
  desktop: "install the desktop app",
};

/** Widest label ("Native dependencies") plus a space, so columns line up. */
const LABEL_WIDTH = 20;

export function renderBanner(): string {
  // Pure ASCII art already -- nothing to downgrade for legacy terminals.
  return BANNER;
}

/**
 * The closing block. `What's left` is emitted only when a step actually failed,
 * so a clean install never shows an empty to-do list.
 */
export function renderSummary(
  steps: readonly SetupStep[],
  totals: SetupTotals,
  caps: TerminalCapabilities,
): string {
  const failed = steps.filter((step) => step.state === "failed");
  const dash = caps.unicode ? "—" : "-";
  const heading = failed.length === 0
    ? "ADE is ready"
    : `ADE installed ${dash} ${failed.length} step${failed.length === 1 ? "" : "s"} need${failed.length === 1 ? "s" : ""} you`;

  const lines: string[] = ["", `  ${heading}`, ""];
  for (const step of steps) {
    if (step.state === "pending") continue;
    const label = step.label.padEnd(LABEL_WIDTH, " ");
    // Where it landed is more useful than "3.1s" once the install is over.
    const detail = step.location ?? step.detail;
    lines.push(`  ${stateSymbol(step.state, caps)} ${label} ${detail}`.trimEnd());
  }

  if (failed.length > 0) {
    lines.push("", "  What's left");
    for (const step of failed) {
      if (!step.nextAction) continue;
      const purpose = NEXT_ACTION_PURPOSE[step.id] ?? step.detail;
      lines.push(`    ${step.nextAction.padEnd(LABEL_WIDTH, " ")} ${purpose}`.trimEnd());
    }
  }

  lines.push("");
  lines.push(
    totals.downloadedBytes > 0
      ? `  Installed in ${formatDuration(totals.elapsedMs)}, ${formatBytes(totals.downloadedBytes)} downloaded`
      : `  Installed in ${formatDuration(totals.elapsedMs)}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Owns every write to the output stream.
 *
 * ANSI mode keeps exactly one animated line alive at the bottom and erases it
 * before printing anything static, so completed steps and prompts never collide
 * with a half-drawn progress bar. Non-ANSI mode degrades to one appended line
 * per step -- no cursor movement, nothing to corrupt a log file.
 */
export class SetupReporter {
  private activeLineDrawn = false;

  constructor(
    private readonly write: (text: string) => void,
    readonly caps: TerminalCapabilities,
  ) {}

  banner(): void {
    this.write(`${renderBanner()}\n`);
  }

  /** Static output. Clears any live line first so nothing is left half-drawn. */
  line(text: string): void {
    this.clearActive();
    this.write(`${text}\n`);
  }

  /**
   * A prompt, written verbatim with no trailing newline so the caret stays on
   * the question's own line and the user types their answer next to it.
   */
  prompt(text: string): void {
    this.clearActive();
    this.write(text);
  }

  beginStep(step: SetupStep): void {
    if (this.caps.ansi) {
      this.drawActive(step, null);
      return;
    }
    this.write(`  ${step.label}...\n`);
  }

  updateStep(step: SetupStep, progress: SetupProgress | null): void {
    if (!this.caps.ansi) return; // no redraw target; completion line reports it
    this.drawActive(step, progress);
  }

  completeStep(step: SetupStep): void {
    this.clearActive();
    this.write(`${formatCompletedLine(step, this.caps)}\n`);
  }

  summary(steps: readonly SetupStep[], totals: SetupTotals): void {
    this.clearActive();
    this.write(renderSummary(steps, totals, this.caps));
  }

  /** Called before prompting and on exit, so we never abandon a drawn line. */
  clearActive(): void {
    if (!this.activeLineDrawn) return;
    this.activeLineDrawn = false;
    if (this.caps.ansi) this.write(CLEAR_LINE);
  }

  private drawActive(step: SetupStep, progress: SetupProgress | null): void {
    this.write(`${CLEAR_LINE}${formatActiveLine(step, progress, this.caps)}`);
    this.activeLineDrawn = true;
  }
}

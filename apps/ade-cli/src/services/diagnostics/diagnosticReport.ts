import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StorageEnvironment } from "./storageEnvironmentProbe";

/**
 * Diagnostic-report assembly and redaction, shared by the desktop
 * "Report issue" button and the headless `ade report-issue` command.
 *
 * Assembly and redaction are pure — they touch neither Electron nor the
 * network, and collection lives in the callers — so both a Markdown report and
 * its redaction can be unit-tested with synthetic inputs on every platform.
 * The one exception is {@link writeDiagnosticReportFile}, which lives here so
 * every surface writes the report with the same owner-only permissions.
 */

/** Where a maintainer files the issue this report is attached to. */
export const DIAGNOSTIC_ISSUE_REPO = "arul28/ADE";

/** GitHub rejects very long URLs (~8 KB); the body in the URL stays a stub. */
export const ISSUE_URL_MAX_LENGTH = 6_000;

/** Per-log-file tail caps. Newest lines are kept, oldest dropped. */
export const LOG_TAIL_MAX_LINES = 120;
export const LOG_TAIL_MAX_BYTES = 32 * 1024;

/**
 * The tighter cap for the SUPPORTING log tails — the project's `main.jsonl`
 * and `ade-cli.jsonl`.
 *
 * Every source added here is weighed against `MAX_DIAGNOSTIC_UPLOAD_BYTES`
 * (512 KB for the whole serialized upload, `apps/desktop/src/shared/diagnosticsUpload.ts`),
 * because a report that grows past it is not sent at all — the exact failure
 * this collector exists to prevent. At the full cap the desktop's eight tails
 * alone would be 256 KB before a single JSON state blob; at this one the two
 * project logs cost 32 KB instead of 64 KB, which is what buys room for the
 * launchd stdout stream and the service definition. The machine-level
 * streams — the service's own stdout/stderr, `brain.jsonl`, and the desktop
 * main process's `desktop-main.jsonl` — keep the full cap, because they are the
 * ones that explain a startup that never got far enough to write anything else.
 */
export const LOG_TAIL_COMPACT_MAX_LINES = 80;
export const LOG_TAIL_COMPACT_MAX_BYTES = 16 * 1024;

/**
 * Service definitions are read from the FRONT, not tailed: a launchd plist
 * states its `Label`, `ProgramArguments` and `EnvironmentVariables` at the top,
 * and a Windows launcher script sets its environment and command before
 * anything else. A tail of either would keep the part nobody needs. Real
 * definitions are 1-2 KB; the cap only bounds the generated PowerShell
 * launcher, whose first 8 KB still carry the whole environment block.
 */
export const SERVICE_DEFINITION_MAX_BYTES = 8 * 1024;

export type DiagnosticRedactionContext = {
  homeDir?: string | null;
  username?: string | null;
  hostname?: string | null;
  /** Absolute project roots collapsed to `<project:name#hash>`. */
  projectRoots?: readonly (string | null | undefined)[];
};

export type DiagnosticLogTail = {
  label: string;
  /** Displayed after redaction, so an absolute path is fine here. */
  path: string;
  text?: string | null;
  error?: string | null;
};

export type DiagnosticVolumeSpace = {
  label: string;
  path: string;
  freeBytes: number | null;
  totalBytes: number | null;
};

export type DiagnosticReportContext = {
  /** Which screen the user pressed the button on. */
  surface: string;
  headline?: string | null;
  code?: string | null;
  technicalDetail?: string | null;
  projectRoot?: string | null;
};

export type DiagnosticReportInput = {
  generatedAt: string;
  app: {
    version: string | null;
    packageChannel?: string | null;
    isPackaged?: boolean | null;
    platform: string;
    arch: string;
    osRelease?: string | null;
    /** macOS `sw_vers -productVersion`, when it could be read. */
    osProductVersion?: string | null;
    electronVersion?: string | null;
    nodeVersion?: string | null;
    chromeVersion?: string | null;
    timezoneOffsetMinutes?: number | null;
  };
  identity: {
    /** PostHog `distinct_id` for this installation (`ade_…`). */
    installId?: string | null;
    /** Truncated one-way hash of the signed-in account id; never the email. */
    accountHash?: string | null;
    machineKeyFingerprint?: string | null;
  };
  context: DiagnosticReportContext;
  /** JSON blobs rendered verbatim (after redaction). */
  state?: {
    localRuntimeStatus?: unknown;
    machineLastFailure?: unknown;
    projectLastFailure?: unknown;
    lastWedge?: unknown;
    recoveryDiagnosis?: unknown;
    updateTransaction?: unknown;
  };
  storage?: readonly DiagnosticVolumeSpace[];
  /**
   * How the reported directories are stored, rather than how full they are.
   *
   * The probe's own type, so a field or an enum member added there is a
   * compile error here rather than a section that silently stops rendering it.
   * The import is `type`-only: this module renders whatever the collector hands
   * it and never reaches for the filesystem itself. Paths are deliberately
   * absent from the shape — this section reports enums and counts, and there is
   * nothing here to leak.
   */
  storageEnvironment?: StorageEnvironment | null;
  logs?: readonly DiagnosticLogTail[];
  /**
   * How this machine's background service is DEFINED — the launchd plist, the
   * systemd unit, the Windows launcher script and scheduled task.
   *
   * Its own section rather than another log, because it answers a different
   * question: not "what did the runtime say" but "what was the runtime told to
   * be". A plist written by an older install without `ELECTRON_RUN_AS_NODE=1`
   * boots the whole desktop app as the background service, which then claims
   * the `ade://` scheme and fights the real GUI for the single-instance lock —
   * a failure with no signature in any log, and invisible until someone asks
   * the user to read the file out loud.
   */
  serviceDefinition?: readonly DiagnosticLogTail[];
  /** Free-form operational notes, e.g. "doctor: not run". */
  notes?: readonly string[];
  redaction?: DiagnosticRedactionContext;
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every textual spelling of an absolute path we might meet in a log line:
 * native separators, JSON-escaped backslashes, percent-encoded, and `file://`.
 */
function pathSpellings(absolutePath: string): string[] {
  const posix = absolutePath.replace(/\\/g, "/");
  const win = absolutePath.replace(/\//g, "\\");
  const spellings = new Set<string>([
    absolutePath,
    posix,
    win,
    win.replace(/\\/g, "\\\\"),
    encodeURIComponent(posix),
    posix.replace(/\//g, "%2F"),
    posix.replace(/\//g, "%2f"),
  ]);
  return [...spellings].filter((value) => value.length > 2);
}

function alternationRegExp(values: readonly string[], flags = "gi"): RegExp | null {
  const parts = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (parts.length === 0) return null;
  return new RegExp(parts.map(escapeRegExp).join("|"), flags);
}

/**
 * Stable, non-reversible label for a project directory: the maintainer can
 * correlate two reports about the same project without learning where it is.
 */
export function projectPathLabel(projectRoot: string): string {
  const normalized = projectRoot.replace(/[\\/]+$/, "");
  const name = normalized.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 6);
  return `<project:${name}#${digest}>`;
}

function isLoopbackIpv4(value: string): boolean {
  return value === "0.0.0.0" || value.startsWith("127.");
}

function isPlausibleIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    return Number(octet) <= 255;
  });
}

/**
 * Word boundaries for the name rules. The surrounding angle brackets are
 * *captured* rather than excluded: an account or machine literally named
 * `user` or `host` — both common on Windows and in containers — otherwise
 * matched inside the `<user>`/`<host>` this function had just produced, and
 * every further pass added another pair of brackets. Excluding `<`/`>` from
 * the boundaries instead would be worse than the bug it fixed: it would also
 * suppress the match for a genuine `user=<ada>` or `Host: <buildbox>` log
 * line, shipping the real name in the report. Re-emitting the brackets keeps
 * the idempotency this module promises (and asserts in its tests) while still
 * redacting bracketed names.
 */
const NAME_BOUNDARY_START = "(?<![A-Za-z0-9_-])";
const NAME_BOUNDARY_END = "(?![A-Za-z0-9_-])";

/** `<ada>` → `<user>`, `ada` → `<user>`, `<user>` → `<user>`. */
function bracketAwarePlaceholder(placeholder: string) {
  return (_match: string, open: string, close: string): string =>
    open === "<" && close === ">" ? placeholder : `${open}${placeholder}${close}`;
}

/**
 * Strips everything that could identify the machine or its owner. Applied to
 * the whole report as the final step, so a section added later cannot leak by
 * forgetting to call it.
 *
 * Idempotent: the placeholders it writes (`~`, `<user>`, `<ip>`, …) never match
 * any of its own patterns, so re-running it is a no-op.
 */
export function redactDiagnosticText(
  text: string,
  context: DiagnosticRedactionContext = {},
): string {
  if (!text) return "";
  let out = text;

  // 1. Project roots first — otherwise the home-dir rule below rewrites their
  //    prefix and the recognizable `<project:…>` label can no longer be formed.
  for (const root of context.projectRoots ?? []) {
    const trimmed = typeof root === "string" ? root.trim() : "";
    if (!trimmed) continue;
    const label = projectPathLabel(trimmed);
    const pattern = alternationRegExp(pathSpellings(trimmed));
    if (pattern) out = out.replace(pattern, label);
  }

  // 2. This machine's home directory, in every spelling.
  const homeDir = context.homeDir?.trim();
  if (homeDir) {
    const pattern = alternationRegExp(pathSpellings(homeDir));
    if (pattern) out = out.replace(pattern, "~");
  }

  // 3. Any other user's home directory shape, so a path we did not anticipate
  //    (another account, a copied log) still cannot name a person.
  out = out
    .replace(/(?:%2F|\/)(?:Users|home)(?:%2F|\/)[^/\\\s"'`,;:)\]}]+/gi, "~")
    .replace(/[A-Za-z]:\\{1,2}Users\\{1,2}[^\\/\s"'`,;:)\]}]+/gi, "~")
    .replace(/[A-Za-z]%3A(?:%5C)+Users(?:%5C)+[^%\s"'`,;:)\]}]+/gi, "~");

  // 4. Emails, before both the account-name rule and the token blobs. Before
  //    the names because an account name is very often the local part of its
  //    owner's address (`ada` / `ada@company.com`): rewriting that first would
  //    leave `<user>@company.com`, which the email pattern can no longer match
  //    (`>` is not a local-part character) — so the employer's domain would
  //    ship in the report. Before the tokens so an address is not eaten as a
  //    secret.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");

  // 5. The OS account name wherever it appears on its own.
  const username = context.username?.trim();
  if (username && username.length >= 3) {
    out = out.replace(
      new RegExp(
        `${NAME_BOUNDARY_START}(<?)${escapeRegExp(username)}(>?)${NAME_BOUNDARY_END}`,
        "gi",
      ),
      bracketAwarePlaceholder("<user>"),
    );
  }

  // 6. Credentials. Prefixed forms first, then key-adjacent blobs.
  out = out
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/g, "<jwt>")
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, "<token>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<token>")
    // Fine-grained GitHub PATs are their own format, not a fifth member of the
    // `gh?_` family: the prefix is a whole word and the body carries
    // underscores, so neither the rule above nor the key/value rule below sees
    // one that appears on its own in a log line. ADE accepts these everywhere
    // it accepts a classic PAT, so an unredacted one is a live credential in a
    // report the user is being told to paste into a public issue.
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<token>")
    .replace(/\bph[cx]_[A-Za-z0-9_-]{16,}/g, "<token>")
    // The remaining real prefixes ADE stores keys for (Google AI, xAI, Groq).
    // Anthropic/OpenAI/DeepSeek/OpenRouter/Moonshot are all `sk-`, already
    // covered above. Together (`tgp_v1_...`) and Mistral (an unprefixed
    // 32-char blob) have no prefix worth matching on: `tg_`/`mistral-` are not
    // key shapes at all, and as patterns they ate ordinary log text
    // (`tg_message_delivery_attempt_count`, the model id
    // `mistral-small-2503-instruct-v1`) -- the real keys are long enough for
    // the key-adjacent `{32,}` rule below. Groq keys are `gsk_` plus a run of
    // base62, so the body deliberately excludes `_`: without that, any long
    // enough `gsk_`-prefixed snake_case identifier disappeared too.
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "<token>")
    .replace(/\bxai-[A-Za-z0-9]{20,}/g, "<token>")
    .replace(/\bgsk_[A-Za-z0-9]{32,}/g, "<token>")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<token>")
    .replace(
      /([?&](?:token|key|api[_-]?key|access[_-]?token|secret|password|pin|sig|signature|code|auth)=)[^&\s"'`<>]+/gi,
      "$1<redacted>",
    )
    .replace(
      /((?:token|secret|password|passwd|authorization|cookie|api[_-]?key|apikey|access[_-]?key)"?\s*[:=]\s*"?)([A-Za-z0-9+/=_-]{32,})/gi,
      "$1<redacted>",
    );

  // 7. URL userinfo (`https://user:pass@host`).
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, "$1<redacted>@");

  // 8. Addresses. Loopback stays: "the brain answered on 127.0.0.1" is the
  //    fact a maintainer needs, and it identifies nobody.
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (match) => {
    if (!isPlausibleIpv4(match)) return match;
    return isLoopbackIpv4(match) ? match : "<ip>";
  });
  out = out.replace(/(?<![0-9a-f:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![0-9a-f:])/gi, "<ip>");
  out = out.replace(
    /(?<![0-9a-f:.])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![0-9a-f:.])/gi,
    (match) => {
      if (match === "::1" || match === "::") return match;
      // Without a digit this is far more likely to be `Namespace::member`
      // than an address, and mangling code identifiers costs real signal.
      return /\d/.test(match) ? "<ip>" : match;
    },
  );

  // 9. Machine and tailnet names.
  const hostname = context.hostname?.trim();
  if (hostname && hostname.length >= 3) {
    const short = hostname.split(".")[0] ?? "";
    // Built here rather than through `alternationRegExp`, which escapes what it
    // is given: escaping an already-assembled pattern turns the word-boundary
    // lookarounds into literal text and the rule silently matches nothing.
    const names = [...new Set([hostname, ...(short.length >= 3 ? [short] : [])])]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (names.length > 0) {
      // Boundaries and brackets hoisted outside the alternation: inside it,
      // each branch would need its own copy and the capture-group numbering
      // would shift with every extra name.
      const pattern = new RegExp(
        `${NAME_BOUNDARY_START}(<?)(?:${names.map((name) => escapeRegExp(name)).join("|")})(>?)${NAME_BOUNDARY_END}`,
        "gi",
      );
      out = out.replace(pattern, bracketAwarePlaceholder("<host>"));
    }
  }
  out = out
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net(?![A-Za-z0-9_-])/gi, "<tailnet-host>")
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9-]{2,}\.local(?![A-Za-z0-9_.-])/gi, "<host>");

  return out;
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/** Keeps the newest lines of a log, bounded by both line count and bytes. */
export function tailLogText(
  text: string,
  limits: { maxLines?: number; maxBytes?: number } = {},
): string {
  const maxLines = limits.maxLines ?? LOG_TAIL_MAX_LINES;
  const maxBytes = limits.maxBytes ?? LOG_TAIL_MAX_BYTES;
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let kept = lines.slice(Math.max(0, lines.length - maxLines));
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > maxBytes) {
    kept = kept.slice(1);
  }
  let joined = kept.join("\n");
  if (Buffer.byteLength(joined, "utf8") > maxBytes) {
    joined = Buffer.from(joined, "utf8").subarray(-maxBytes).toString("utf8").replace(/^�+/, "");
  }
  return joined;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "unknown";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function bullet(label: string, value: unknown): string {
  const text =
    value == null || value === ""
      ? "unknown"
      : typeof value === "string"
        ? value
        : String(value);
  return `- ${label}: ${text}`;
}

/** Omits the line entirely when there is nothing to say, instead of "unknown". */
function optionalBullet(label: string, value: unknown): string | null {
  if (value == null || value === "") return null;
  return bullet(label, value);
}

function lines(...values: (string | null)[]): string {
  return values.filter((value): value is string => value != null).join("\n");
}

/**
 * Wraps `body` in a fence longer than any backtick run inside it, so a log line
 * that itself contains ``` cannot break out of the block.
 */
function fence(body: string, language = ""): string {
  const longestRun = [...body.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  const marker = "`".repeat(Math.max(3, longestRun + 1));
  return [marker + language, body, marker].join("\n");
}

function jsonBlock(value: unknown): string {
  try {
    return fence(JSON.stringify(value, null, 2) ?? "null", "json");
  } catch {
    return fence("(unserializable)", "");
  }
}

function section(title: string, body: string | null): string | null {
  if (!body || !body.trim()) return null;
  return `## ${title}\n\n${body.trim()}`;
}

/**
 * One captured file, rendered so an ABSENCE reads as loudly as a presence.
 *
 * A file that could not be read still gets its heading and its path with the
 * reason underneath, because "we looked here and found nothing" and "we never
 * looked" are different facts and only one of them is the reader's problem.
 */
function fileEntryBlock(entry: DiagnosticLogTail): string {
  const heading = `### ${entry.label}\n\n\`${entry.path}\``;
  if (entry.error) return `${heading}\n\n${entry.error}`;
  const text = (entry.text ?? "").trim();
  if (!text) return `${heading}\n\n(empty)`;
  return `${heading}\n\n${fence(text)}`;
}

function fileEntriesSection(title: string, entries: readonly DiagnosticLogTail[]): string | null {
  if (entries.length === 0) return null;
  return section(title, entries.map(fileEntryBlock).join("\n\n"));
}

/**
 * The storage-environment section, or null when the collector did not run one.
 *
 * Deliberately flat prose bullets rather than a JSON blob: the reader of a
 * report is looking for one sentence — "the project is in iCloud Drive and 47
 * of 200 sampled files are not downloaded" — and that sentence is the whole
 * point of the section.
 */
function storageEnvironmentBlock(
  environment: DiagnosticReportInput["storageEnvironment"],
): string | null {
  if (!environment) return null;
  const rows = environment.roots.map((root) => {
    if (root.error) return `- ${root.label}: ${root.location} — ${root.error}`;
    const sampleNote = root.sampleTruncated ? ", sample truncated" : "";
    return `- ${root.label}: ${root.location} — ${root.datalessFiles} of ${root.sampledFiles} sampled files not downloaded${sampleNote}`;
  });
  const launchd = environment.process.launchdManaged;
  const processRow = `- Collected by: ${environment.process.processType} on ${environment.process.platform}${
    launchd == null ? "" : launchd ? ", started by launchd" : ", not started by launchd"
  }`;
  // Stated as a sentence rather than a boolean, because the whole value of the
  // line is which of two very different failures the reader is looking at.
  const materialize = environment.process.materializeDatalessFiles;
  const policyRow = materialize == null
    ? null
    : materialize
      ? "- Cloud file downloads: the background service is allowed to download evicted files"
      : "- Cloud file downloads: this computer's background service is NOT allowed to download evicted files (launch agent predates MaterializeDatalessFiles)";
  const limitations = (environment.limitations ?? []).map((note) => `- ${note}`);
  return [...rows, processRow, policyRow, ...limitations]
    .filter((row): row is string => row != null)
    .join("\n");
}

/**
 * Renders the Markdown report, then redacts the whole thing. Redaction runs on
 * the assembled text rather than per-field on purpose: a future section cannot
 * leak by forgetting to opt in.
 */
export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const { app, identity, context } = input;
  const projectRoots = [
    context.projectRoot,
    ...(input.redaction?.projectRoots ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const parts: (string | null)[] = [];

  parts.push("# ADE diagnostic report");

  parts.push(
    section(
      "What happened",
      lines(
        bullet("Surface", context.surface),
        optionalBullet("Headline", context.headline),
        optionalBullet("Recovery code", context.code),
        bullet("Generated", input.generatedAt),
      ),
    ),
  );

  const osLine = [app.osProductVersion, app.osRelease].filter(Boolean).join(" / ") || null;
  parts.push(
    section(
      "Install",
      lines(
        bullet("ADE version", app.version),
        optionalBullet("Channel", app.packageChannel),
        optionalBullet("Packaged", app.isPackaged == null ? null : String(app.isPackaged)),
        bullet("Platform", `${app.platform} ${app.arch}`),
        optionalBullet("OS", osLine),
        optionalBullet("Electron", app.electronVersion),
        optionalBullet("Node", app.nodeVersion),
        optionalBullet("Chrome", app.chromeVersion),
        optionalBullet(
          "Timezone offset (min)",
          app.timezoneOffsetMinutes == null ? null : String(app.timezoneOffsetMinutes),
        ),
        // The one line that makes the whole report correlatable: this is the
        // PostHog `distinct_id` for anonymous events from this installation.
        bullet("Install id (PostHog distinct_id)", identity.installId),
        optionalBullet("Account hash", identity.accountHash),
        optionalBullet("Machine key fingerprint", identity.machineKeyFingerprint),
        bullet("Project", context.projectRoot ? projectPathLabel(context.projectRoot) : "none"),
      ),
    ),
  );

  parts.push(section("Technical detail", context.technicalDetail ? fence(context.technicalDetail) : null));

  const state = input.state ?? {};
  parts.push(section("Runtime status", state.localRuntimeStatus == null ? null : jsonBlock(state.localRuntimeStatus)));
  parts.push(section("Recovery diagnosis", state.recoveryDiagnosis == null ? null : jsonBlock(state.recoveryDiagnosis)));
  parts.push(section("Last failure (machine)", state.machineLastFailure == null ? null : jsonBlock(state.machineLastFailure)));
  parts.push(section("Last failure (project)", state.projectLastFailure == null ? null : jsonBlock(state.projectLastFailure)));
  parts.push(section("Last wedge", state.lastWedge == null ? null : jsonBlock(state.lastWedge)));
  parts.push(section("Update transaction", state.updateTransaction == null ? null : jsonBlock(state.updateTransaction)));

  const storage = input.storage ?? [];
  parts.push(
    section(
      "Disk space",
      storage.length
        ? storage
            .map((entry) => `- ${entry.label} (${entry.path}): ${formatBytes(entry.freeBytes)} free of ${formatBytes(entry.totalBytes)}`)
            .join("\n")
        : null,
    ),
  );

  parts.push(section("Storage environment", storageEnvironmentBlock(input.storageEnvironment)));

  // Before the logs: what the service was told to be explains what the logs
  // then show, and it is short enough to read first.
  parts.push(fileEntriesSection("Background service definition", input.serviceDefinition ?? []));

  parts.push(fileEntriesSection("Logs", input.logs ?? []));

  parts.push(
    section("Notes", (input.notes ?? []).length ? (input.notes ?? []).map((note) => `- ${note}`).join("\n") : null),
  );

  const rendered = parts.filter((part): part is string => Boolean(part)).join("\n\n") + "\n";

  return redactDiagnosticText(rendered, {
    ...input.redaction,
    projectRoots,
  });
}

// ---------------------------------------------------------------------------
// GitHub issue URL
// ---------------------------------------------------------------------------

export type DiagnosticIssueUrlInput = {
  surface: string;
  headline?: string | null;
  code?: string | null;
  appVersion?: string | null;
  platform?: string | null;
  arch?: string | null;
  installId?: string | null;
  repo?: string;
  /**
   * Same context the report body is redacted with. The headline is caller
   * supplied (an update failure message, a runtime error) and routinely
   * carries absolute paths, so the title and stub body get the same treatment
   * as the report before they are put in a URL.
   */
  redaction?: DiagnosticRedactionContext;
};

export function diagnosticIssueTitle(input: DiagnosticIssueUrlInput): string {
  const headline = input.headline?.trim();
  const base = headline || `Problem on the ${input.surface.replace(/_/g, " ")} screen`;
  const suffix = input.code?.trim() ? ` (${input.code.trim()})` : "";
  const title = `[report] ${base}${suffix}`;
  return (input.redaction ? redactDiagnosticText(title, input.redaction) : title).slice(0, 180);
}

/**
 * The URL carries only a stub: the full report is on the clipboard, because a
 * GitHub issue URL stops working somewhere north of 8 KB.
 */
export function diagnosticIssueBody(input: DiagnosticIssueUrlInput): string {
  const body = [
    "<!-- Paste the report from your clipboard below. -->",
    "",
    "**What I was doing:**",
    "",
    "",
    "---",
    "",
    bullet("Surface", input.surface),
    ...(input.code ? [bullet("Recovery code", input.code)] : []),
    bullet("ADE version", input.appVersion),
    bullet("Platform", [input.platform, input.arch].filter(Boolean).join(" ") || null),
    bullet("Install id", input.installId),
    "",
    "Paste the full diagnostic report from your clipboard here:",
    "",
  ].join("\n");
  return input.redaction ? redactDiagnosticText(body, input.redaction) : body;
}

export function buildDiagnosticIssueUrl(input: DiagnosticIssueUrlInput): string {
  const repo = input.repo?.trim() || DIAGNOSTIC_ISSUE_REPO;
  const url = new URL(`https://github.com/${repo}/issues/new`);
  url.searchParams.set("title", diagnosticIssueTitle(input));
  url.searchParams.set("labels", "bug");
  const body = diagnosticIssueBody(input);
  url.searchParams.set("body", body);
  if (url.toString().length <= ISSUE_URL_MAX_LENGTH) return url.toString();
  // Degrade to a title-only link rather than handing the browser a URL the
  // GitHub frontend will reject outright.
  const short = new URL(`https://github.com/${repo}/issues/new`);
  short.searchParams.set("title", diagnosticIssueTitle(input));
  return short.toString();
}

/** `2026-08-16T09-30-00-000Z-project_recovery.md`, safe on every filesystem. */
export function diagnosticReportFileName(surface: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const slug = surface.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
  return `${stamp}-${slug}.md`;
}

/** Convenience for callers that already know the directory. */
export function diagnosticReportFilePath(dir: string, surface: string, at: Date): string {
  return path.join(dir, diagnosticReportFileName(surface, at));
}

/**
 * Writes the report with an owner-only directory and file. Best effort: a
 * read-only or full disk must not turn "report a bug" into a second bug, and
 * the issue URL is still usable on its own.
 *
 * Shared by every surface (desktop button, `ade report-issue`, the TUI) so the
 * 0o700/0o600 modes are stated in exactly one place.
 */
export function writeDiagnosticReportFile(filePath: string, report: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, report, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The text behind "Copy diagnostics" on a provider page.
 *
 * One paste has to answer "what does this machine think about this provider",
 * so it carries the status word and message, the version, every left-rail fact
 * (binary path, config home, credential source), the last auth probe error, and
 * — where the vendor ships one — the output of its own `doctor`.
 *
 * Absent facts are named rather than omitted: a missing line reads as "not
 * checked", which is a different claim from "not found".
 */

import type { AcpProviderDiagnostics } from "../../../../shared/types/config";
import type { ProviderFact, ProviderStatusView } from "./types";

export function formatProviderDiagnosticsReport(args: {
  label: string;
  status: ProviderStatusView;
  version: string | null;
  facts: ProviderFact[];
  acp: AcpProviderDiagnostics | null;
}): string {
  const lines = [
    `provider: ${args.label}`,
    `status: ${args.status.label} — ${args.status.message}`,
    `version: ${args.version ?? args.acp?.versionError ?? "unknown"}`,
  ];
  for (const fact of args.facts) {
    lines.push(`${fact.label.toLowerCase()}: ${fact.value}`);
  }
  const probeError = args.acp?.lastProbe && args.acp.lastProbe.state !== "ready"
    ? `${args.acp.lastProbe.state} — ${args.acp.lastProbe.message ?? "no detail"}`
    : args.status.errorLine ?? null;
  lines.push(`last error: ${probeError ?? "none"}`);
  if (args.acp) {
    lines.push(`binary source: ${args.acp.binarySource}`);
    lines.push(`checked at: ${args.acp.checkedAt}`);
  }
  if (args.acp?.doctor) {
    lines.push(
      "",
      `$ ${args.acp.doctor.command}  (exit ${args.acp.doctor.exitCode ?? "none"})`,
      args.acp.doctor.output,
    );
  }
  return lines.join("\n");
}

/** Text that may hold a token: an `sk-…` key, a JWT, a bearer header, or any long unbroken run. */
const SECRET_RUN = /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|xai|fk)[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}|\b[A-Za-z0-9_\-+/=]{24,}/g;
const BEARER = /\b(bearer)(\s+)()[^\s"',;&]+/gi;
const KEY_VALUE = /\b(token|code|key|secret|password|state|api[_-]?key|access[_-]?token|refresh[_-]?token)(\s*[:=]\s*)("?)[^\s"',;&]+/gi;
const URL_TAIL = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * A sign-in's words with everything that could sign someone in taken out: a
 * link keeps its address but loses its query (it carries the one-time state
 * and code), the one-time code itself goes, and so does anything shaped like
 * a key or a token. Email addresses go too: a support paste names no person.
 */
function redactSignInText(text: string, knownSecrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    const value = secret?.trim();
    if (value && value.length >= 4) out = out.split(value).join("[removed]");
  }
  return out
    .replace(URL_TAIL, "$1?[removed]")
    .replace(BEARER, (_match, word: string, sep: string, quote: string) => `${word}${sep}${quote}[removed]`)
    .replace(KEY_VALUE, (_match, word: string, sep: string, quote: string) => `${word}${sep}${quote}[removed]`)
    .replace(SECRET_RUN, "[removed]")
    .replace(EMAIL, "[email]");
}

/**
 * The text behind "Copy details for support" on a failed sign-in: what was
 * tried, where, and what the provider printed last, with no token, code or
 * key in it (`redactSignInText`).
 */
export function formatSignInFailureReport(args: {
  provider: string;
  providerLabel: string;
  /** "this computer", or the other computer's name. */
  place: string;
  /** What the sign-in was doing when it stopped (starting, waiting, checking). */
  stage: string;
  title: string;
  detail: string | null;
  output: string | null;
  /** The one-time code and link of this attempt, removed wherever they appear. */
  secrets?: ReadonlyArray<string | null | undefined>;
}): string {
  const secrets = args.secrets ?? [];
  const tail = (args.output ?? "").trim().split("\n").slice(-40).join("\n");
  const platform = typeof navigator !== "undefined" ? navigator.platform || "unknown" : "unknown";
  const lines = [
    `sign-in: ${args.providerLabel} (${args.provider})`,
    `on: ${args.place}`,
    `stopped while: ${args.stage}`,
    `result: ${redactSignInText(args.title, secrets)}`,
    `why: ${args.detail ? redactSignInText(args.detail, secrets) : "no detail"}`,
    `window platform: ${platform}`,
    `time: ${new Date().toISOString()}`,
  ];
  if (tail) lines.push("", "last output:", redactSignInText(tail, secrets));
  return lines.join("\n");
}

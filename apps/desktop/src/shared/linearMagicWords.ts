import type { LaneLinearIssue } from "./types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function linearPrMagicWord(closeOnMerge: boolean): "Fixes" | "Refs" {
  return closeOnMerge ? "Fixes" : "Refs";
}

export function buildLinearPrTitle(issue: LaneLinearIssue): string {
  return `${issue.identifier}: ${issue.title}`.trim();
}

export function buildLinearPrReference(issue: LaneLinearIssue, closeOnMerge: boolean): string {
  return `${linearPrMagicWord(closeOnMerge)} ${issue.identifier}`;
}

export function ensureLinearPrReference(
  body: string,
  issue: LaneLinearIssue,
  closeOnMerge: boolean,
  options: { preserveExisting?: boolean } = {},
): string {
  const reference = buildLinearPrReference(issue, closeOnMerge);
  const identifier = escapeRegExp(issue.identifier);
  const supportedLineRe = new RegExp(`^(?:Refs|Fixes)\\s+${identifier}\\s*$`, "im");
  if (supportedLineRe.test(body)) {
    return options.preserveExisting === false
      ? body.replace(supportedLineRe, reference)
      : body;
  }
  const knownMagicRe = new RegExp(`\\b(?:Refs|Fixes)\\s+${identifier}\\b`, "i");
  if (knownMagicRe.test(body)) return body;
  const trimmed = body.trimStart();
  return trimmed.length ? `${reference}\n\n${trimmed}` : `${reference}\n`;
}

export function ensureLinearCommitReference(message: string, issue: LaneLinearIssue): string {
  const trimmed = message.trim();
  if (!trimmed.length) return trimmed;
  const identifier = escapeRegExp(issue.identifier);
  const knownMagicRe = new RegExp(`\\b(?:Refs|Fixes)\\s+${identifier}\\b`, "i");
  if (knownMagicRe.test(trimmed)) return trimmed;
  return `Refs ${issue.identifier}: ${trimmed}`;
}

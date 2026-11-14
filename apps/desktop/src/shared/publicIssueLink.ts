import { ADE_GITHUB_URL } from "./productLinks";

/**
 * The one public GitHub link a report can lead to, after the report itself
 * went to the ADE team privately.
 *
 * The ADE repository is public, so the issue holds only what is safe for
 * anyone to read: the report's reference, the ADE version and channel, and
 * the OS family. Never the report, its logs, the raw error, the notice's
 * headline (it can name a path, a branch or a person) or any id. Every value
 * is checked against a narrow shape and dropped when it does not fit, so a
 * caller cannot put free text here by mistake.
 *
 * Pure and free of Node built-ins: the desktop main process, the web client
 * and the CLI build the same link with it.
 */

export type PublicIssueOsFamily = "macOS" | "Windows" | "Linux";

export type PublicIssueLinkInput = {
  /** The reference the private report was stored under. */
  reference: string;
  appVersion?: string | null;
  /** `stable`, `beta`, `alpha`, `development` or `web`. */
  channel?: string | null;
  osFamily?: PublicIssueOsFamily | null;
};

const REFERENCE_SHAPE = /^[A-Za-z0-9-]{4,32}$/;
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const CHANNEL_SHAPE = /^[a-z]{2,16}$/;
const OS_FAMILIES: ReadonlySet<string> = new Set(["macOS", "Windows", "Linux"]);

/** `process.platform` (or a browser's platform string) as a family name; null when unknown. */
export function osFamilyOf(platform: string | null | undefined): PublicIssueOsFamily | null {
  const value = (platform ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "darwin" || value.startsWith("mac") || value.includes("mac os")) return "macOS";
  if (value === "win32" || value.startsWith("win")) return "Windows";
  if (value === "linux" || value.includes("linux") || value.includes("x11")) return "Linux";
  return null;
}

function safe(value: string | null | undefined, shape: RegExp): string | null {
  const trimmed = value?.trim() ?? "";
  return shape.test(trimmed) ? trimmed : null;
}

/** The issue body: the reference, version, channel, OS family and one sentence. */
export function publicIssueBody(input: PublicIssueLinkInput): string {
  const reference = safe(input.reference, REFERENCE_SHAPE);
  const version = safe(input.appVersion, VERSION_SHAPE);
  const channel = safe(input.channel, CHANNEL_SHAPE);
  const os = input.osFamily && OS_FAMILIES.has(input.osFamily) ? input.osFamily : null;
  const versionLine = version ? `${version}${channel ? ` (${channel})` : ""}` : channel ? `unknown (${channel})` : "unknown";
  return [
    "<!-- This page is public. Do not paste logs, file paths or anything private here. -->",
    "",
    "**What happened:**",
    "",
    "",
    "---",
    "",
    `- Report reference: ${reference ?? "unknown"}`,
    `- ADE version: ${versionLine}`,
    `- OS: ${os ?? "unknown"}`,
    "",
    reference
      ? `The private report is with the ADE team under reference ${reference}.`
      : "The private report is with the ADE team.",
    "",
  ].join("\n");
}

/** A prefilled new-issue link on the public ADE repository; null without a usable reference. */
export function buildPublicIssueUrl(input: PublicIssueLinkInput): string | null {
  const reference = safe(input.reference, REFERENCE_SHAPE);
  if (!reference) return null;
  const url = new URL(`${ADE_GITHUB_URL}/issues/new`);
  url.searchParams.set("title", `Report ${reference}`);
  url.searchParams.set("labels", "bug");
  url.searchParams.set("body", publicIssueBody({ ...input, reference }));
  return url.toString();
}

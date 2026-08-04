import type { AppInfo } from "../../../shared/types/core";
import type { AppPackageChannel } from "../../../shared/packageChannel";
import { ADE_GITHUB_NEW_ISSUE_URL } from "../../../shared/productLinks";

/**
 * GitHub rejects new-issue links whose query is too long (it 414s well before
 * the browser's own limit). Real diagnostics are ~600 chars, so this only ever
 * bites if a version/OS string is pathological — truncate rather than hand the
 * user a link that dead-ends.
 */
export const MAX_ISSUE_URL_LENGTH = 6000;

export type BugReportIssueUrlInput = {
  appInfo: AppInfo | null;
  /**
   * The synchronously-known channel. Used when `appInfo` has not arrived (or
   * failed), so the report is still labelled with the right build.
   */
  channel: AppPackageChannel;
  /**
   * Best-effort OS version string. On Windows this is where the build number
   * lands; AppInfo does not carry it, so the caller sniffs it from the user
   * agent / userAgentData and passes what it got.
   */
  osRelease?: string | null;
  newIssueUrl?: string;
};

function fieldRow(label: string, value: string | null | undefined): string {
  return `- ${label}: ${value && value.trim() ? value.trim() : "unknown"}`;
}

export function buildBugReportIssueBody(input: BugReportIssueUrlInput): string {
  const info = input.appInfo;
  const channel = info?.packageChannel ?? input.channel;
  const platform = info?.platform ?? "unknown";
  const arch = info?.arch ?? "unknown";
  const diagnostics = [
    fieldRow("ADE version", info?.appVersion),
    fieldRow("Package channel", channel),
    fieldRow("Platform", `${platform} (${arch})`),
    fieldRow("OS release", input.osRelease),
    fieldRow("Electron", info?.versions.electron),
    fieldRow("Chrome", info?.versions.chrome),
    fieldRow("Node", info?.versions.node),
    fieldRow("Packaged", info ? String(info.isPackaged) : null),
  ].join("\n");

  return [
    "### What happened",
    "",
    "",
    "### What you expected",
    "",
    "",
    "### Steps to reproduce",
    "1. ",
    "2. ",
    "",
    "### Build",
    diagnostics,
    "",
  ].join("\n");
}

export function buildBugReportIssueTitle(input: BugReportIssueUrlInput): string {
  const info = input.appInfo;
  const channel = info?.packageChannel ?? input.channel;
  const version = info?.appVersion ? ` ${info.appVersion}` : "";
  const platform = info?.platform ? ` ${info.platform}` : "";
  return `[${channel}${version}${platform}] `;
}

/**
 * Prefilled GitHub new-issue URL for the current build.
 *
 * The repository comes from `ADE_GITHUB_URL`, which mirrors
 * apps/desktop/package.json `build.publish` — no second hardcoded owner/repo.
 */
export function buildBugReportIssueUrl(input: BugReportIssueUrlInput): string {
  const base = input.newIssueUrl ?? ADE_GITHUB_NEW_ISSUE_URL;
  const title = buildBugReportIssueTitle(input);
  const body = buildBugReportIssueBody(input);

  const withBody = (candidateBody: string): string => {
    const params = new URLSearchParams();
    params.set("title", title);
    params.set("body", candidateBody);
    params.set("labels", "bug");
    return `${base}?${params.toString()}`;
  };

  const full = withBody(body);
  if (full.length <= MAX_ISSUE_URL_LENGTH) return full;

  // Shrink the body until the whole URL fits. Encoding can triple a character's
  // length, so step down rather than compute an exact cut.
  let trimmed = body;
  while (trimmed.length > 0 && withBody(trimmed).length > MAX_ISSUE_URL_LENGTH) {
    trimmed = trimmed.slice(0, Math.max(0, Math.floor(trimmed.length * 0.8) - 1));
  }
  return withBody(trimmed);
}

/** Chromium reports Windows 11 as `platformVersion` major >= 13. */
function windowsMarketingName(major: number): string | null {
  if (!Number.isFinite(major)) return null;
  if (major >= 13) return "Windows 11";
  if (major > 0) return "Windows 10";
  return null;
}

/**
 * Best-effort OS version for the report. `navigator.userAgentData` is the only
 * renderer-side source of the Windows build number, and it is async and
 * permissioned; `navigator.userAgent` freezes at "Windows NT 10.0" for both
 * Windows 10 and 11, so it is the fallback rather than the answer.
 */
export async function detectOsRelease(): Promise<string | null> {
  if (typeof navigator === "undefined") return null;
  const uaData = (
    navigator as Navigator & {
      userAgentData?: {
        platform?: string;
        getHighEntropyValues?: (
          hints: string[],
        ) => Promise<{ platform?: string; platformVersion?: string }>;
      };
    }
  ).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const values = await uaData.getHighEntropyValues(["platformVersion"]);
      const platform = values.platform ?? uaData.platform ?? "";
      const version = values.platformVersion ?? "";
      if (version) {
        if (/windows/i.test(platform)) {
          const major = Number.parseInt(version.split(".")[0] ?? "", 10);
          const marketing = windowsMarketingName(major);
          return marketing ? `${marketing} (platformVersion ${version})` : `Windows ${version}`;
        }
        return `${platform || "unknown"} ${version}`.trim();
      }
    } catch {
      /* fall through to the user agent */
    }
  }
  const ua = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const match = /\(([^)]+)\)/.exec(ua);
  return match?.[1] ?? (ua || null);
}

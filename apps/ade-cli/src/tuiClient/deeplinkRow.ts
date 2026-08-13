// ---------------------------------------------------------------------------
// Helper for the "copy ADE deeplink" keybinding in the TUI.
//
// Resolves whatever the TUI has focused — a lanes-picker or PR-picker row, or
// an open plugin panel — to a canonical `ade://` URL. Keeping this isolated
// from the Ink component lets us unit-test the dispatch path without rendering
// the whole app.
// ---------------------------------------------------------------------------

import { buildDeeplink, type DeeplinkEnvelope, type DeeplinkTarget } from "../../../desktop/src/shared/deeplinks";
import {
  isValidPluginId,
  isValidPluginManifestIdentifier,
} from "../../../desktop/src/shared/plugins/manifest";
import { buildWebClientUrl } from "../../../desktop/src/shared/webClientUrl";

/**
 * Minimal lane shape needed to build a lane deeplink. Subset of `LaneSummary`
 * so tests can construct fixtures without pulling the full type.
 */
export type DeeplinkLaneRow = {
  id: string;
  repoOwner?: string | null;
  repoName?: string | null;
  branchRef?: string | null;
  branch?: string | null;
  prNumber?: number | null;
  linearIssue?: { identifier?: string | null } | null;
};

/**
 * Minimal PR shape needed to build a PR deeplink. We accept either an explicit
 * `repoOwner`/`repoName`/`prNumber` triple or a GitHub `url` we can parse —
 * the lane-details right pane only carries the URL, so we lift owner/repo
 * from there at the call site.
 */
export type DeeplinkPrRow =
  | { repoOwner: string; repoName: string; prNumber: number }
  | { url: string; prNumber?: number };

export type DeeplinkRow =
  | { kind: "lane"; lane: DeeplinkLaneRow }
  | { kind: "pr"; pr: DeeplinkPrRow }
  | { kind: "plugin"; pluginId: string; panelId: string; context?: Record<string, unknown> };

/**
 * Pull `{owner, name, number}` out of a GitHub PR URL like
 * `https://github.com/<owner>/<repo>/pull/<n>`. Returns `null` for anything
 * that doesn't look like a PR URL we recognize.
 */
export function parseGitHubPrUrl(url: string): { repoOwner: string; repoName: string; prNumber: number } | null {
  if (!url || typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // /<owner>/<repo>/pull/<n>
  if (segments.length < 4) return null;
  const [repoOwner, repoName, kind, numberRaw] = segments;
  if (kind !== "pull") return null;
  const prNumber = Number(numberRaw);
  if (!Number.isInteger(prNumber) || prNumber < 1) return null;
  return { repoOwner, repoName, prNumber };
}

export function deeplinkTargetForRow(row: DeeplinkRow): DeeplinkTarget | null {
  const isValidPrNumber = (value: number): boolean =>
    Number.isInteger(value) && value > 0;

  if (row.kind === "lane") {
    if (!row.lane.id) return null;
    // Preserve the richer deeplink envelope (repo/branch/PR/Linear context) from
    // the deeplinks-overhaul grammar, but return the TARGET so both the ade://
    // and app.ade-app.dev web-URL builders below share one resolution path.
    const branch = (row.lane.branch ?? row.lane.branchRef ?? "").replace(/^refs\/heads\//, "");
    const envelope: DeeplinkEnvelope | undefined = row.lane.repoOwner && row.lane.repoName
      ? {
          repoOwner: row.lane.repoOwner,
          repoName: row.lane.repoName,
          ...(branch ? { branch } : {}),
          ...(row.lane.prNumber ? { prNumber: row.lane.prNumber } : {}),
          ...(row.lane.linearIssue?.identifier ? { linearIssue: row.lane.linearIssue.identifier } : {}),
        }
      : undefined;
    return { kind: "lane", laneId: row.lane.id, ...(envelope ? { envelope } : {}) };
  }

  if (row.kind === "plugin") {
    // The ids are the manifest's, so the shared parser is the authority on
    // whether they are linkable; an unlinkable pair returns null here rather
    // than minting a URL that would not parse back.
    if (!isValidPluginId(row.pluginId) || !isValidPluginManifestIdentifier(row.panelId)) return null;
    return {
      kind: "plugin",
      pluginId: row.pluginId,
      panelId: row.panelId,
      ...(row.context ? { context: row.context } : {}),
    };
  }

  const pr = row.pr;
  if ("repoOwner" in pr) {
    if (!pr.repoOwner || !pr.repoName || !isValidPrNumber(pr.prNumber)) return null;
    return { kind: "pr", repoOwner: pr.repoOwner, repoName: pr.repoName, prNumber: pr.prNumber };
  }
  const parsed = parseGitHubPrUrl(pr.url);
  if (!parsed) return null;
  const prNumber = pr.prNumber ?? parsed.prNumber;
  if (!isValidPrNumber(prNumber)) return null;
  return { kind: "pr", repoOwner: parsed.repoOwner, repoName: parsed.repoName, prNumber };
}

/** Build the `ade://` deeplink for a focused lane or PR row. Returns `null`
 * when the row doesn't have enough data (e.g. a PR row with a malformed
 * URL and no explicit owner/repo). */
export function buildDeeplinkForRow(row: DeeplinkRow): string | null {
  const target = deeplinkTargetForRow(row);
  return target ? buildDeeplink(target, { form: "ade" }) : null;
}

export function buildWebClientUrlForRow(row: DeeplinkRow): string | null {
  // Every row kind the TUI can focus now has a hosted destination, plugin
  // panels included: the web client mounts the same `/plugin/:pluginId` route
  // the desktop App does, reads panels off the sync `plugin_subscribe` stream
  // and runs their actions through the `plugins.invoke` remote command. This
  // used to return null because the hosted client hosted no plugin tabs and a
  // link would have landed the reader on its welcome surface.
  //
  // The link does not promise the plugin is installed on whichever machine the
  // reader's browser connects to. It does not have to: the page answers that
  // itself, in the same words desktop uses ("Not installed here"), which is a
  // better outcome than withholding the link from the reader who does have it.
  const target = deeplinkTargetForRow(row);
  return target ? buildWebClientUrl(target) : null;
}

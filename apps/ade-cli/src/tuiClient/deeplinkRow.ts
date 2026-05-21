// ---------------------------------------------------------------------------
// Helper for the "copy ADE deeplink" keybinding in the TUI.
//
// Resolves the focused row in the lanes-picker / PR-picker contexts to a
// canonical `ade://` URL. Keeping this isolated from the Ink component lets us
// unit-test the dispatch path without rendering the whole app.
// ---------------------------------------------------------------------------

import { buildDeeplink, type DeeplinkTarget } from "../../../desktop/src/shared/deeplinks";

/**
 * Minimal lane shape needed to build a lane deeplink. Subset of `LaneSummary`
 * so tests can construct fixtures without pulling the full type.
 */
export type DeeplinkLaneRow = { id: string };

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
  | { kind: "pr"; pr: DeeplinkPrRow };

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

/** Build the `ade://` deeplink for a focused lane or PR row. Returns `null`
 * when the row doesn't have enough data (e.g. a PR row with a malformed
 * URL and no explicit owner/repo). */
export function buildDeeplinkForRow(row: DeeplinkRow): string | null {
  const isValidPrNumber = (value: number): boolean =>
    Number.isInteger(value) && value > 0;

  if (row.kind === "lane") {
    if (!row.lane.id) return null;
    const target: DeeplinkTarget = { kind: "lane", laneId: row.lane.id };
    return buildDeeplink(target, { form: "ade" });
  }
  const pr = row.pr;
  if ("repoOwner" in pr) {
    if (!pr.repoOwner || !pr.repoName || !isValidPrNumber(pr.prNumber)) return null;
    return buildDeeplink(
      { kind: "pr", repoOwner: pr.repoOwner, repoName: pr.repoName, prNumber: pr.prNumber },
      { form: "ade" },
    );
  }
  const parsed = parseGitHubPrUrl(pr.url);
  if (!parsed) return null;
  const prNumber = pr.prNumber ?? parsed.prNumber;
  if (!isValidPrNumber(prNumber)) return null;
  return buildDeeplink(
    { kind: "pr", repoOwner: parsed.repoOwner, repoName: parsed.repoName, prNumber },
    { form: "ade" },
  );
}

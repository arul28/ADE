/**
 * orchestrationEvidence — pure derivation helpers for the run's evidence UI.
 *
 * Evidence = the bundle assets that record what the outside world saw (proof
 * captures, computer-use, video, PRs, Linear issues, deeplinks, screenshots,
 * test logs). These helpers turn `manifest.assets` into (a) per-agent chip
 * lists keyed by the producing session and (b) an aggregated, sorted list for
 * the run-level "Evidence" section.
 *
 * Everything here is a stateless pure function so it can be unit-tested without
 * rendering. The panel derives from the already-subscribed manifest — no new
 * IPC, no pollers (see ade-perf-work).
 */

import type {
  OrchestrationAgent,
  OrchestrationAsset,
  OrchestrationAssetKind,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";
import { buildDeeplink } from "../../../shared/deeplinks";

/**
 * Asset kinds that count as run evidence. Plan-authoring assets (`html_spec`,
 * `doc`) are intentionally excluded — those live with the plan narrative, not
 * the evidence roll-up.
 */
export const EVIDENCE_ASSET_KINDS: ReadonlySet<OrchestrationAssetKind> = new Set([
  "proof_artifact",
  "computer_use",
  "video",
  "pr_link",
  "linear_issue",
  "deeplink",
  "screenshot",
  "test_log",
]);

export function isEvidenceAsset(asset: OrchestrationAsset): boolean {
  return EVIDENCE_ASSET_KINDS.has(asset.kind);
}

export type EvidenceItem = {
  asset: OrchestrationAsset;
  /** The producing agent, resolved from `registeredBySessionId`; null if unknown. */
  agent: OrchestrationAgent | null;
};

/** basename of a bundle-relative path (no extension trimming). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * A compact, human label for an evidence chip:
 *   pr_link       → "PR #123"
 *   linear_issue  → the Linear id (e.g. "ENG-42")
 *   proof_artifact/screenshot/video/computer_use → the file name
 *   deeplink      → "link"
 *   test_log      → the file name
 */
export function evidenceChipLabel(asset: OrchestrationAsset): string {
  switch (asset.kind) {
    case "pr_link": {
      const n = asset.externalRef?.prNumber;
      return typeof n === "number" ? `PR #${n}` : "PR";
    }
    case "linear_issue":
      return asset.externalRef?.linearId?.trim() || "issue";
    case "deeplink":
      return "link";
    default:
      return basename(asset.path);
  }
}

/** Longer, plain-language label for the aggregated Evidence section. */
export function evidenceKindLabel(kind: OrchestrationAssetKind): string {
  switch (kind) {
    case "proof_artifact":
      return "proof";
    case "computer_use":
      return "computer use";
    case "video":
      return "video";
    case "pr_link":
      return "pull request";
    case "linear_issue":
      return "Linear issue";
    case "deeplink":
      return "deeplink";
    case "screenshot":
      return "screenshot";
    case "test_log":
      return "test log";
    default:
      return kind;
  }
}

/**
 * The openable target for an asset, if any.
 *
 * PR / Linear / deeplink assets carry an explicit `url` in `externalRef` — that
 * takes precedence. Proof / computer-use / video assets instead carry only an
 * `externalRef.artifactId`; for those we derive the canonical `ade://artifact/<id>`
 * deeplink so the row/chip is openable (it resolves through ADE's existing
 * artifact/proof deeplink handling). Everything else is non-interactive.
 */
export function evidenceExternalUrl(asset: OrchestrationAsset): string | null {
  const url = asset.externalRef?.url?.trim();
  if (url) return url;
  const artifactId = asset.externalRef?.artifactId?.trim();
  if (artifactId) {
    return buildDeeplink({ kind: "artifact", artifactId }, { form: "ade" });
  }
  return null;
}

const KIND_ORDER: OrchestrationAssetKind[] = [
  "pr_link",
  "linear_issue",
  "deeplink",
  "proof_artifact",
  "computer_use",
  "video",
  "screenshot",
  "test_log",
  "html_spec",
  "doc",
];

function kindRank(kind: OrchestrationAssetKind): number {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

/**
 * Evidence assets grouped by the producing session id. Only assets that carry a
 * `registeredBySessionId` appear here (that's how a chip attaches to an agent
 * row). Assets are ordered by kind, then registration order (assets keep append
 * order in the manifest).
 */
export function deriveAgentEvidence(
  manifest: Pick<OrchestrationManifest, "assets"> | null | undefined,
): Map<string, OrchestrationAsset[]> {
  const byAgent = new Map<string, OrchestrationAsset[]>();
  for (const asset of manifest?.assets ?? []) {
    if (!isEvidenceAsset(asset)) continue;
    const sessionId = asset.registeredBySessionId;
    if (!sessionId) continue;
    const arr = byAgent.get(sessionId) ?? [];
    arr.push(asset);
    byAgent.set(sessionId, arr);
  }
  for (const arr of byAgent.values()) {
    arr.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  }
  return byAgent;
}

/**
 * The aggregated, run-level evidence list: every evidence asset paired with its
 * producing agent (resolved from `registeredBySessionId`), ordered by kind then
 * append order. Used by the "Evidence" section in the run panel.
 */
export function deriveRunEvidence(
  manifest:
    | Pick<OrchestrationManifest, "assets" | "agents">
    | null
    | undefined,
): EvidenceItem[] {
  const agentBySession = new Map<string, OrchestrationAgent>();
  for (const agent of manifest?.agents ?? []) {
    agentBySession.set(agent.sessionId, agent);
  }
  const items: EvidenceItem[] = [];
  for (const asset of manifest?.assets ?? []) {
    if (!isEvidenceAsset(asset)) continue;
    items.push({
      asset,
      agent: asset.registeredBySessionId
        ? agentBySession.get(asset.registeredBySessionId) ?? null
        : null,
    });
  }
  // Stable sort by kind rank; assets already carry append order within a kind.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byKind = kindRank(a.item.asset.kind) - kindRank(b.item.asset.kind);
      return byKind !== 0 ? byKind : a.index - b.index;
    })
    .map(({ item }) => item);
}

/** A short "role · tag" label for the producing agent, or "unknown". */
export function evidenceAgentLabel(agent: OrchestrationAgent | null): string {
  if (!agent) return "unknown";
  return agent.tag ? `${agent.role} · ${agent.tag}` : agent.role;
}

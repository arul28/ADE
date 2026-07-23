/**
 * EvidenceSection + EvidenceChips — the run's evidence UI.
 *
 * `EvidenceChips` renders a compact, per-row strip of an agent's registered
 * evidence assets (kind icon + short label) for the Agents roster.
 *
 * `EvidenceSection` renders the aggregated, run-level "Evidence" roll-up: every
 * evidence asset with its producing agent and kind, with external links
 * (PR / Linear / deeplink) opening through ADE's existing link handling.
 *
 * Both derive purely from `manifest.assets` (already subscribed) — no new IPC,
 * no timers (see ade-perf-work). See orchestrationEvidence.ts for the pure
 * derivation helpers.
 */

import { useMemo } from "react";
import {
  Camera,
  FileText,
  GitPullRequest,
  Image as ImageIcon,
  LinkSimple,
  ListChecks,
  Monitor,
  Sparkle,
  Ticket,
  VideoCamera,
} from "@phosphor-icons/react";
import type {
  OrchestrationAsset,
  OrchestrationAssetKind,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";
import { cn } from "../ui/cn";
import { openAdeDeeplink, openUrlInAdeBrowser } from "../../lib/openExternal";
import { SectionHeader } from "./PanelChrome";
import {
  deriveRunEvidence,
  evidenceAgentLabel,
  evidenceChipLabel,
  evidenceExternalUrl,
  evidenceKindLabel,
  isInternalEvidenceTarget,
} from "./orchestrationEvidence";

/**
 * Open an evidence target: in-app `ade://` deeplinks (artifact/computer-use/video
 * refs, or `deeplink` assets pointing at ADE surfaces) route through internal
 * navigation; external http(s)/file URLs open in the built-in browser.
 */
function openEvidenceTarget(url: string): void {
  if (isInternalEvidenceTarget(url)) {
    openAdeDeeplink(url);
    return;
  }
  openUrlInAdeBrowser(url);
}

export const ORCHESTRATION_EVIDENCE_SECTION_TEST_ID = "orchestration-evidence-section";

/* ──────────────────────────────────────────────────────────────────────────
   Kind icon
   ────────────────────────────────────────────────────────────────────────── */

function EvidenceKindIcon({
  kind,
  size = 11,
}: {
  kind: OrchestrationAssetKind;
  size?: number;
}) {
  switch (kind) {
    case "pr_link":
      return <GitPullRequest size={size} weight="duotone" />;
    case "linear_issue":
      return <Ticket size={size} weight="duotone" />;
    case "deeplink":
      return <LinkSimple size={size} weight="duotone" />;
    case "proof_artifact":
      return <Camera size={size} weight="duotone" />;
    case "computer_use":
      return <Monitor size={size} weight="duotone" />;
    case "video":
      return <VideoCamera size={size} weight="duotone" />;
    case "screenshot":
      return <ImageIcon size={size} weight="duotone" />;
    case "test_log":
      return <ListChecks size={size} weight="duotone" />;
    default:
      return <FileText size={size} weight="duotone" />;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Per-row chips (Agents roster)
   ────────────────────────────────────────────────────────────────────────── */

export function EvidenceChips({
  assets,
  max = 4,
}: {
  assets: OrchestrationAsset[];
  max?: number;
}) {
  if (!assets.length) return null;
  const shown = assets.slice(0, max);
  const overflow = assets.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="orchestration-evidence-chips">
      {shown.map((asset) => (
        <EvidenceChip key={asset.id} asset={asset} />
      ))}
      {overflow > 0 ? (
        <span className="inline-flex items-center text-[10px] text-muted-fg/45">+{overflow}</span>
      ) : null}
    </div>
  );
}

function EvidenceChip({ asset }: { asset: OrchestrationAsset }) {
  const url = evidenceExternalUrl(asset);
  const label = evidenceChipLabel(asset);
  const kindLabel = evidenceKindLabel(asset.kind);
  const inner = (
    <>
      <EvidenceKindIcon kind={asset.kind} size={10} />
      <span className="max-w-[120px] truncate">{label}</span>
    </>
  );
  const base =
    "inline-flex items-center gap-1 rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-[2px] font-sans text-[10px] text-fg/70";
  if (url) {
    return (
      <button
        type="button"
        data-orchestration-evidence-chip={asset.kind}
        title={`${kindLabel} — ${label} (open)`}
        onClick={() => openEvidenceTarget(url)}
        className={cn(base, "transition-colors hover:bg-white/[0.06] hover:text-fg/90")}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      data-orchestration-evidence-chip={asset.kind}
      title={`${kindLabel} — ${label}`}
      className={base}
    >
      {inner}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Aggregated Evidence section
   ────────────────────────────────────────────────────────────────────────── */

export function EvidenceSection({
  manifest,
}: {
  manifest: OrchestrationManifest | null;
}) {
  const items = useMemo(() => deriveRunEvidence(manifest), [manifest]);
  if (!items.length) return null;
  return (
    <div
      data-testid={ORCHESTRATION_EVIDENCE_SECTION_TEST_ID}
      className="mt-4 border-t border-white/[0.05] px-3 py-3"
    >
      <SectionHeader icon={<Sparkle size={11} weight="duotone" />}>
        Evidence
      </SectionHeader>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map(({ asset, agent }) => {
          const url = evidenceExternalUrl(asset);
          const label = evidenceChipLabel(asset);
          const row = (
            <>
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg/60">
                <EvidenceKindIcon kind={asset.kind} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-sans text-[12px] text-fg/85" title={asset.path}>
                  {label}
                </span>
                <span className="block truncate font-sans text-[10.5px] text-muted-fg/55">
                  {evidenceKindLabel(asset.kind)}
                  {" · "}
                  {evidenceAgentLabel(agent)}
                </span>
              </span>
              {url ? (
                <LinkSimple size={11} weight="bold" className="shrink-0 text-sky-200/70" />
              ) : null}
            </>
          );
          return (
            <li key={asset.id}>
              {url ? (
                <button
                  type="button"
                  data-orchestration-evidence-row={asset.kind}
                  onClick={() => openEvidenceTarget(url)}
                  title={`Open ${evidenceKindLabel(asset.kind)} — ${label}`}
                  className="flex w-full items-center gap-2 rounded-md border border-white/[0.05] bg-white/[0.015] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                >
                  {row}
                </button>
              ) : (
                <div
                  data-orchestration-evidence-row={asset.kind}
                  className="flex w-full items-center gap-2 rounded-md border border-white/[0.05] bg-white/[0.015] px-2 py-1.5"
                >
                  {row}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

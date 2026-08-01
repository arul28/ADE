import { GitBranch, Warning } from "@phosphor-icons/react";
import type {
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflight,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
  GitHubPrListItem,
  GitHubPrSnapshot,
  LaneSummary,
} from "../../../../shared/types";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../../lanes/laneDesignTokens";
import { branchNameFromRef } from "./githubPrBranch";

type CreateLaneFromPrBranchApi = {
  preflightCreateLaneFromPrBranch: (
    args: CreateLaneFromPrBranchArgs,
  ) => Promise<CreateLaneFromPrBranchPreflightResult>;
  createLaneFromPrBranch: (
    args: CreateLaneFromPrBranchArgs,
  ) => Promise<CreateLaneFromPrBranchResult>;
};

export function formatActionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || "Action failed.";
}

export function createLaneFromPrBranchApi(): CreateLaneFromPrBranchApi {
  return window.ade.prs as typeof window.ade.prs & CreateLaneFromPrBranchApi;
}

export function createLaneFromPrBranchArgs(item: GitHubPrListItem): CreateLaneFromPrBranchArgs {
  return {
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber,
  };
}

export function createLaneFromPrBranchRequestKey(item: GitHubPrListItem): string {
  return `${item.repoOwner}/${item.repoName}#${Number(item.githubPrNumber)}`;
}

function preflightText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = preflightText(record.message) ?? preflightText(record.reason) ?? preflightText(record.summary);
    if (message) return message;
    try {
      return JSON.stringify(value);
    } catch {
      return "Conflict details unavailable.";
    }
  }
  return String(value);
}

function preflightPrNumber(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): number {
  return Number(preflight?.githubPrNumber ?? item.githubPrNumber);
}

function preflightTitle(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.title) ?? item.title;
}

function preflightRemoteBranch(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.remoteBranch) ?? preflightText(preflight?.headBranch) ?? item.headBranch ?? "---";
}

function preflightImportRef(preflight: CreateLaneFromPrBranchPreflight | null): string | null {
  return preflightText(preflight?.importBranchRef);
}

function preflightTargetLaneName(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  const remoteBranch = preflightRemoteBranch(preflight, item);
  const fallback = branchNameFromRef(remoteBranch);
  return preflightText(preflight?.targetLaneName) ?? (fallback || "New lane");
}

function preflightBaseBranch(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.baseBranch) ?? item.baseBranch ?? "---";
}

function preflightBlockingConflict(preflight: CreateLaneFromPrBranchPreflight | null): string | null {
  return preflightText(preflight?.blockingConflict);
}

export function createLaneMappedPrId(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.pr?.id);
}

export function createLaneMappedLaneId(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.pr?.laneId) ?? preflightText(result.lane?.id);
}

export function createLaneMappedLaneName(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.lane?.name);
}

export function upsertLaneSummary(lanes: LaneSummary[], lane: LaneSummary): LaneSummary[] {
  const index = lanes.findIndex((entry) => entry.id === lane.id);
  if (index === -1) return [lane, ...lanes];
  const next = lanes.slice();
  next[index] = lane;
  return next;
}

export function canCreateLaneFromPrBranch(item: GitHubPrListItem, lanes: LaneSummary[]): boolean {
  if (item.linkedPrId || item.scope !== "repo") return false;
  if (item.state !== "open" && item.state !== "draft") return false;
  const headBranch = branchNameFromRef(item.headBranch);
  if (!headBranch) return false;
  return !lanes.some((lane) => !lane.archivedAt && branchNameFromRef(lane.branchRef) === headBranch);
}

function sameGitHubPr(left: GitHubPrListItem, right: GitHubPrListItem): boolean {
  return left.repoOwner === right.repoOwner
    && left.repoName === right.repoName
    && Number(left.githubPrNumber) === Number(right.githubPrNumber);
}

export function patchSnapshotWithMappedPr(
  snapshot: GitHubPrSnapshot,
  item: GitHubPrListItem,
  args: {
    mappedPrId: string;
    laneId: string | null;
    laneName: string | null;
  },
): GitHubPrSnapshot {
  const patchItems = (items: GitHubPrListItem[]) => items.map((candidate) => {
    if (candidate.id !== item.id && !sameGitHubPr(candidate, item)) return candidate;
    return {
      ...candidate,
      linkedPrId: args.mappedPrId,
      linkedLaneId: args.laneId ?? candidate.linkedLaneId,
      linkedLaneName: args.laneName ?? candidate.linkedLaneName,
      adeKind: candidate.adeKind ?? "single",
    };
  });
  return {
    ...snapshot,
    repoPullRequests: patchItems(snapshot.repoPullRequests),
    externalPullRequests: patchItems(snapshot.externalPullRequests),
  };
}

export function CreateLaneFromPrBranchDialog({
  item,
  preflight,
  loading,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  item: GitHubPrListItem;
  preflight: CreateLaneFromPrBranchPreflight | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const blockingConflict = preflightBlockingConflict(preflight);
  const canConfirm = Boolean(preflight?.canCreate) && !loading && !busy;
  const sourceBranch = preflightRemoteBranch(preflight, item);
  const importRef = preflightImportRef(preflight);
  const rows = [
    ["PR", `#${preflightPrNumber(preflight, item)} ${preflightTitle(preflight, item)}`],
    ["Source branch", sourceBranch],
    ...(importRef && importRef !== sourceBranch ? [["Import ref", importRef] as const] : []),
    ["Target lane", preflightTargetLaneName(preflight, item)],
    ["Base branch", preflightBaseBranch(preflight, item)],
  ] as const;

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.52)",
        backdropFilter: "blur(10px)",
        padding: 20,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-lane-from-pr-title"
        style={{
          width: "min(560px, 100%)",
          borderRadius: 12,
          border: `1px solid ${COLORS.border}`,
          background: COLORS.cardBgSolid,
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div id="create-lane-from-pr-title" style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>
            Create lane from PR branch
          </div>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          {loading ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
              Checking branch ownership and PR head availability...
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map(([label, value]) => (
                <div key={label} style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 12, alignItems: "baseline" }}>
                  <div style={LABEL_STYLE}>{label}</div>
                  <div style={{ fontFamily: label === "PR" ? SANS_FONT : MONO_FONT, fontSize: 12, color: COLORS.textSecondary, minWidth: 0, overflowWrap: "anywhere" }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
          )}
          {blockingConflict ? (
            <div style={{
              display: "flex",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 9,
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.18)",
              color: COLORS.danger,
              fontFamily: SANS_FONT,
              fontSize: 12,
              lineHeight: 1.5,
            }}>
              <Warning size={15} weight="fill" style={{ marginTop: 2, flexShrink: 0 }} />
              <span>{blockingConflict}</span>
            </div>
          ) : null}
          {error ? (
            <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5 }}>
              {error}
            </div>
          ) : null}
        </div>
        <div style={{ padding: "14px 20px", display: "flex", justifyContent: "flex-end", gap: 10, borderTop: `1px solid ${COLORS.border}` }}>
          <button type="button" onClick={onCancel} disabled={busy} style={outlineButton({ height: 34, opacity: busy ? 0.6 : 1 })}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            style={primaryButton({ height: 34, opacity: canConfirm ? 1 : 0.5 })}
          >
            <GitBranch size={14} /> {busy ? "Creating..." : "Create lane"}
          </button>
        </div>
      </div>
    </div>
  );
}
